// One phone call: Twilio's media socket on one side, a Gemini Live session on the other, barber-core
// for everything about the salon. Gemini hears and speaks every language itself, so the caller may
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
    const max = Number(o.maxDurationSeconds) > 0 ? Number(o.maxDurationSeconds) : 600;
    this.timers.push(this.deps.setTimer(max * 1000, () => { this.endedReason = 'exceeded-max-duration'; void this.hangUp(); }));
    this.gemini = this.deps.openGemini({
      onOpen: () => this.gemini?.send(JSON.stringify({
        setup: {
          model: `models/${this.deps.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.voice } } } },
          systemInstruction: { parts: [{ text: fillPrompt(this.deps.prompt, o.variableValues ?? {}) }] },
          tools: geminiTools(),
        },
      })),
      onMessage: (text) => void this.fromGemini(text),
      onClose: () => { if (!this.closed) { this.endedReason = 'gemini-closed'; void this.hangUp(); } },
    });
  }

  /** Twilio "media": the caller's audio. */
  fromCaller(payloadB64: string) {
    if (this.ready && this.gemini) {
      this.gemini.send(JSON.stringify({ realtimeInput: { audio: { data: phoneToGemini(payloadB64), mimeType: 'audio/pcm;rate=16000' } } }));
    }
  }

  private async fromGemini(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    // Gemini says it will close the session soon (goAway): log why, so a short call can be explained
    if (m.goAway) this.deps.log('gemini_go_away', { timeLeft: String(m.goAway.timeLeft ?? '') });
    if (m.setupComplete) {
      this.ready = true;
      // the AI disclosure and the recording notice come first, word for word (barber-core's opening)
      this.gemini?.send(JSON.stringify({ clientContent: {
        turns: [{ role: 'user', parts: [{ text: `The call has started. Say exactly this, then wait for the caller: "${this.opening}"` }] }],
        turnComplete: true,
      } }));
    }
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data) this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: geminiToPhone(part.inlineData.data, part.inlineData.mimeType) } }));
    }
    // the caller spoke over the AI: drop what Twilio still has queued
    if (m.serverContent?.interrupted) this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    if (m.toolCall?.functionCalls?.length) await this.runTools(m.toolCall.functionCalls);
  }

  private async runTools(calls: { id: string; name: string; args?: unknown }[]) {
    const responses: { id: string; name: string; response: unknown }[] = [];
    const forCore = calls.filter((c) => CORE_TOOL_NAMES.has(c.name));
    let results: { toolCallId: string; result: string }[] = [];
    if (forCore.length) {
      try {
        results = await this.deps.core.tools(this.ids, forCore.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
      } catch (e: any) {
        this.deps.log('core_tools_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
      }
    }
    for (const c of calls) {
      if (c.name === 'end_call') {
        responses.push({ id: c.id, name: c.name, response: { ok: true } });
        this.endedReason = 'assistant-ended-call';
        this.timers.push(this.deps.setTimer(HANGUP_DELAY_MS, () => void this.hangUp()));
        continue;
      }
      if (!CORE_TOOL_NAMES.has(c.name)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'unknown_tool' } }); continue; }
      const raw = results.find((x) => x.toolCallId === c.id)?.result;
      let result: any = { ok: false, reason: 'system_error' };
      try { if (raw) result = JSON.parse(raw); } catch { /* keep system_error */ }
      this.deps.log('tool_result', { tool: c.name, ok: result?.ok === true });
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
