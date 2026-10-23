// One phone call: Twilio's media socket on one side, a Gemini Live session on the other, barber-core
// for everything about the salon. Gemini hears and speaks English, Spanish and Persian, so the caller may
// switch language at any time. The salon, the caller and the call id come from Twilio (signed), never
// from what anyone says. Timers and sockets are passed in, so the whole flow runs in tests.
import { geminiToPhone, phoneToGemini } from './audio.ts';
import { fillPrompt, type CallIds, type CoreClient } from './core.ts';
import { CORE_TOOL_NAMES, geminiTools } from './tools.ts';
import { dialTwiml, hangupTwiml, sayTwiml } from './twilio.ts';

export type SocketLike = { send(data: string): void; close(): void };
export type SessionDeps = {
  core: CoreClient;
  /** Opens the Gemini Live socket; `onMessage` gets each server message as text. */
  openGemini(handlers: { onOpen(): void; onMessage(text: string): void; onClose(): void }): SocketLike;
  /** Replaces what the live call does (Twilio REST): a transfer, a notice, a hang-up. */
  updateCall(callSid: string, twiml: string): Promise<{ ok: boolean; error?: string }>;
  prompt: string;
  model: string;
  voice: string;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(t: unknown): void;
  now(): Date;
  log(event: string, data: Record<string, unknown>): void;
};

const TRANSFER_DELAY_MS = 4000; // the AI says "connecting you now" first
const HANGUP_DELAY_MS = 3000;

export class CallSession {
  private gemini: SocketLike | null = null;
  private ready = false;
  private streamSid = '';
  private ids: CallIds & { callSid: string } = { callId: '', callSid: '', to: '', from: '' };
  private started = '';
  private endedReason = 'customer-ended-call';
  private timers: unknown[] = [];
  private closed = false;
  private opening = '';
  private openingPlayed = false;
  private openingAudioEmitted = false;
  private openingMarkName = '';
  private callerLanguage = '';
  private defaultLanguage = '';
  // Twilio can begin sending audio before barber-core and Gemini finish setting up.
  // Keep a short lead-in so the caller's first words are available for language detection.
  private pendingAudio: string[] = [];

  private deps: SessionDeps;
  private twilio: SocketLike;

  constructor(deps: SessionDeps, twilio: SocketLike) {
    this.deps = deps;
    this.twilio = twilio;
  }

  /** Twilio's "start": the call is verified by the caller of this method (stream token). */
  async start(streamSid: string, p: { callSid: string; to: string; from: string }) {
    this.streamSid = streamSid;
    this.ids = { callId: p.callSid, callSid: p.callSid, to: p.to, from: p.from };
    this.started = this.deps.now().toISOString();
    let r: any;
    try {
      r = await this.deps.core.start(this.ids);
    } catch (e: any) {
      this.deps.log('core_start_failed', { call: p.callSid, error: String(e?.message ?? e) });
      r = { error: 'Sorry, this number cannot take calls right now. Please try again later.' };
    }
    if (r?.destination?.number) return this.handOff(dialTwiml(r.destination.number, p.from) ?? sayTwiml(''), 'assistant-forwarded-call');
    if (typeof r?.error === 'string' || !r?.assistantOverrides) return this.handOff(sayTwiml(String(r?.error ?? '')), 'assistant-request-returned-error');
    const o = r.assistantOverrides;
    this.opening = String(o.firstMessage ?? '');
    this.defaultLanguage = String(o.variableValues?.default_language ?? '');
    const max = Number(o.maxDurationSeconds) > 0 ? Number(o.maxDurationSeconds) : 600;
    this.timers.push(this.deps.setTimer(max * 1000, () => { this.endedReason = 'exceeded-max-duration'; void this.hangUp(); }));
    this.gemini = this.deps.openGemini({
      onOpen: () => this.gemini?.send(JSON.stringify({
        setup: {
          model: `models/${this.deps.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.voice } } } },
          systemInstruction: { parts: [{ text: `${fillPrompt(this.deps.prompt, o.variableValues ?? {})}\n\n${this.openingInstructions()}` }] },
          tools: geminiTools(),
        },
      })),
      onMessage: (text) => void this.fromGemini(text),
      onClose: () => { if (!this.closed) { this.endedReason = 'gemini-closed'; void this.hangUp(); } },
    });
  }

  /** Twilio "media": the caller's audio. */
  fromCaller(payloadB64: string) {
    if (!this.ready || !this.gemini || !this.openingPlayed) {
      // At 20 ms per Twilio frame this retains about fifteen seconds, with bounded memory use.
      if (this.pendingAudio.length === 750) this.pendingAudio.shift();
      this.pendingAudio.push(payloadB64);
      return;
    }
    this.sendCallerAudio(payloadB64);
  }

  private sendCallerAudio(payloadB64: string) {
    this.gemini?.send(JSON.stringify({ realtimeInput: { audio: { data: phoneToGemini(payloadB64), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  private openingInstructions() {
    return `# First response and language\nThe first response is barber-core's canonical opening below. Say it exactly as written, word for word, before responding to the caller. Do not translate, paraphrase, shorten, or omit it. It contains the AI disclosure and recording notice. Wait until this opening has finished playing before using any tool or handling the caller's request.\n\nEnglish, Spanish and Persian (fa-IR) are the only supported languages. Once the caller speaks, detect their language from their first sentence, reply in that language automatically without asking them to choose, and switch among these three languages whenever the caller switches. Call set_caller_language with the identified code before taking any action and whenever the caller switches. For booking and reminder tools, pass the caller's current language code: en, es, or fa-IR. Preserve salon settings, booking rules, and existing tool behavior.\n\nCanonical barber-core firstMessage: ${JSON.stringify(this.opening)}`;
  }

  private async fromGemini(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (m.setupComplete) {
      this.ready = true;
      this.gemini?.send(JSON.stringify({ clientContent: {
        turns: [{ role: 'user', parts: [{ text: `The call has started. Say exactly this, then wait for the caller: ${JSON.stringify(this.opening)}` }] }],
        turnComplete: true,
      } }));
    }
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data) {
        this.openingAudioEmitted = true;
        this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: geminiToPhone(part.inlineData.data, part.inlineData.mimeType) } }));
      }
    }
    if (!this.openingPlayed && this.openingAudioEmitted && m.serverContent?.turnComplete && !this.openingMarkName) {
      this.openingMarkName = `opening-complete-${this.streamSid}`;
      this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: this.openingMarkName } }));
    }
    // the caller spoke over the AI: drop what Twilio still has queued
    if (m.serverContent?.interrupted) this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    if (m.toolCall?.functionCalls?.length) await this.runTools(m.toolCall.functionCalls);
  }

  async fromTwilioMark(name: string) {
    if (!name || name !== this.openingMarkName || this.openingPlayed) return;
    this.openingMarkName = '';
    this.openingPlayed = true;
    const bufferedAudio = this.pendingAudio;
    this.pendingAudio = [];
    for (const payload of bufferedAudio) this.sendCallerAudio(payload);
  }

  private async runTools(calls: { id: string; name: string; args?: unknown }[]) {
    if (!this.openingPlayed) {
      this.gemini?.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response: { ok: false, reason: 'opening_required' } })) } }));
      return;
    }
    const languageCall = calls.find((c) => c.name === 'set_caller_language');
    const toolLanguage = (languageCall?.args as any)?.language;
    const argLanguage = calls.map((c) => (c.args as any)?.language).find((language) => typeof language === 'string');
    const requestedLanguage = typeof toolLanguage === 'string' ? toolLanguage : typeof argLanguage === 'string' ? argLanguage : '';
    if (requestedLanguage) this.callerLanguage = requestedLanguage;
    const deniedActiveLanguage = !!this.callerLanguage && !isAllowedCallerLanguage(this.callerLanguage);
    const hasDisallowedExplicitLanguage = calls.some((c) => CORE_TOOL_NAMES.has(c.name) && typeof (c.args as any)?.language === 'string' && !isAllowedCallerLanguage((c.args as any).language));
    const responses: { id: string; name: string; response: unknown }[] = [];
    const blockedLanguageCalls = new Set(calls.filter((c) => {
      if (!CORE_TOOL_NAMES.has(c.name)) return false;
      const language = (c.args as any)?.language || this.callerLanguage || (c.name === 'previous_visit_reminder' ? this.defaultLanguage : '');
      return deniedActiveLanguage || hasDisallowedExplicitLanguage || !isAllowedCallerLanguage(language);
    }).map((c) => c.id));
    const forCore = calls.filter((c) => CORE_TOOL_NAMES.has(c.name) && !blockedLanguageCalls.has(c.id));
    let results: { toolCallId: string; result: string }[] = [];
    if (forCore.length) {
      try {
        results = await this.deps.core.tools(this.ids, forCore.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
      } catch (e: any) {
        this.deps.log('core_tools_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
      }
    }
    for (const c of calls) {
      if (c.name === 'set_caller_language') {
        const language = (c.args as any)?.language;
        const accepted = isAllowedCallerLanguage(language);
        responses.push({ id: c.id, name: c.name, response: accepted ? { ok: true, language } : { ok: false, reason: 'language_not_enabled' } });
        continue;
      }
      if (c.name === 'end_call') {
        if (!isAllowedCallerLanguage(this.callerLanguage)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'language_not_enabled' } }); continue; }
        responses.push({ id: c.id, name: c.name, response: { ok: true } });
        this.endedReason = 'assistant-ended-call';
        this.timers.push(this.deps.setTimer(HANGUP_DELAY_MS, () => void this.hangUp()));
        continue;
      }
      if (!CORE_TOOL_NAMES.has(c.name)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'unknown_tool' } }); continue; }
      if (blockedLanguageCalls.has(c.id)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'language_not_enabled' } }); continue; }
      const raw = results.find((x) => x.toolCallId === c.id)?.result;
      let result: any = { ok: false, reason: 'system_error' };
      try { if (raw) result = JSON.parse(raw); } catch { /* keep system_error */ }
      responses.push({ id: c.id, name: c.name, response: result });
      // barber-core said a person can take the call now (only while the salon is open): move it there
      if (c.name === 'transfer_to_human' && result?.ok === true && typeof result.transfer_to === 'string') {
        const twiml = dialTwiml(result.transfer_to, this.ids.from);
        if (twiml) this.timers.push(this.deps.setTimer(TRANSFER_DELAY_MS, () => void this.handOff(twiml, 'assistant-forwarded-call')));
      }
    }
    this.gemini?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }

  private async handOff(twiml: string, reason: string) {
    this.endedReason = reason;
    const r = await this.deps.updateCall(this.ids.callSid, twiml);
    if (!r.ok) this.deps.log('twilio_update_failed', { call: this.ids.callSid, error: r.error ?? '' });
    await this.finish();
  }

  private async hangUp() {
    if (this.closed) return;
    await this.deps.updateCall(this.ids.callSid, hangupTwiml());
    await this.finish();
  }

  /** Twilio "stop" or the socket closed: report the call to barber-core once. */
  async finish() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) this.deps.clearTimer(t);
    this.gemini?.close();
    if (!this.ids.callSid) return;
    try {
      await this.deps.core.end(this.ids, { startedAt: this.started, endedAt: this.deps.now().toISOString(), endedReason: this.endedReason });
    } catch (e: any) {
      this.deps.log('core_end_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
    }
  }
}

function isAllowedCallerLanguage(value: unknown): boolean {
  return value === 'en' || value === 'es' || value === 'fa-IR';
}
