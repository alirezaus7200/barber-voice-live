// One phone call: Twilio's media socket on one side, a Gemini Live session on the other, barber-core
// for everything about the salon. Gemini hears and speaks every language itself, so the caller may
// switch language at any time. The salon, the caller and the call id come from Twilio (signed), never
// from what anyone says. Timers and sockets are passed in, so the whole flow runs in tests.
import { geminiToPhone, mulawToPcm16, phoneToGemini } from './audio.ts';
import { fillPrompt, type CallIds, type CoreClient } from './core.ts';
import { CORE_TOOL_NAMES, geminiTools } from './tools.ts';
import { dialTwiml, hangupTwiml, sayTwiml } from './twilio.ts';

export type SocketLike = { send(data: string): void; close(): void };
export type SessionDeps = {
  core: CoreClient;
  /** Opens the Gemini Live socket; `onMessage` gets each server message as text. */
  openGemini(handlers: { onOpen(): void; onMessage(text: string): void; onClose(code?: number): void }): SocketLike;
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
const HANGUP_DELAY_MS = 1500; // after the goodbye is fully said
const GOODBYE_MAX_MS = 15000; // safety: hang up even if the goodbye never completes
const TIME_WARNING_S = 40; // seconds before the call cap when the AI is told to wrap up (enough to take a message)
const TIME_NUDGE = 'About 40 seconds are left in this call. If a booking is not finished, ask the one question still missing, short, and finish it now. If it cannot be finished, ask the caller: shall I connect you to the barber, or take a message for the barber? (Offer to connect them only if the salon is open now; otherwise offer only the message.) Then stop and wait for the answer. If they want a message, take it with take_message, then say a short goodbye in the caller\'s language and call end_call. Never say goodbye in the same turn as a question.';
const SILENCE_NUDGE_MS = 30000; // the caller says nothing this long: the AI thanks them and ends the call (fewer paid seconds)
const REASK_MS = 7000; // the AI asked and the caller says nothing this long: the AI asks again (callers do not wait in silence)
const REASK = 'The caller has not answered for about 7 seconds. Ask your last question again, shorter and clearly, in the caller\'s language. If it was about a booking, keep going with the booking.';
const REASK_OFFER = 'The caller still has not answered. If a booking is not finished, ask: shall I connect you to the barber, or take a message for the barber? (Offer to connect only if the salon is open now; otherwise offer only the message.) If the booking is done, ask if there is anything else. Then wait for the answer.';
const OPENING_MAX_MS = 20000; // Twilio never confirmed the opening was played: the caller is heard anyway after this
const SPEECH_PEAK = 1500; // of 32767: louder than the line's background noise
const SILENCE_NUDGE = 'The caller has been silent for about 30 seconds. Thank them for calling, say they are welcome to call again to book their appointment, then call end_call. Say it in the caller\'s last language.';

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
  private lastSpeechAt = 0;
  private nudged = false;
  private aiWaitingSince = 0; // the AI finished a turn and waits for the caller (0: it does not)
  private reasks = 0; // re-asks since the caller last spoke (at most 2)
  private hangUpWhenSaid = false;
  private outcome = false; // a booking, a message or a transfer happened in this call
  private refusedEnd = false; // the first early end_call is refused once, so the AI asks again
  private variables: Record<string, unknown> = {};
  private retried = false;
  private t0 = 0; // when Twilio's start came (ms), for the start-up timings
  private firstAudio = false;
  // The opening (AI disclosure, recording notice) is heard in full: until Twilio confirms it was played,
  // the caller's audio is not passed on, so a "hello?" cannot cut it off.
  private openingHeard = false;
  private openingTries = 0;
  private turnAudio = false; // the AI's current turn had audio
  private openingSpoken = false; // the AI has started saying the opening (no tool runs before that)

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
    this.t0 = this.deps.now().getTime();
    let r: any;
    try {
      r = await this.deps.core.start(this.ids);
    } catch (e: any) {
      this.deps.log('core_start_failed', { call: p.callSid, error: String(e?.message ?? e) });
      r = { error: 'Sorry, this number cannot take calls right now. Please try again later.' };
    }
    if (r?.destination?.number) return this.handOff(dialTwiml(r.destination.number, p.from) ?? sayTwiml(''), 'assistant-forwarded-call');
    if (typeof r?.error === 'string' || !r?.assistantOverrides) return this.handOff(sayTwiml(String(r?.error ?? '')), 'assistant-request-returned-error');
    this.step('core_answered');
    const o = r.assistantOverrides;
    this.opening = String(o.firstMessage ?? '');
    const max = Number(o.maxDurationSeconds) > 0 ? Number(o.maxDurationSeconds) : 600;
    this.timers.push(this.deps.setTimer(max * 1000, () => { this.endedReason = 'exceeded-max-duration'; void this.hangUp(); }));
    // shortly before the cap the AI wraps up itself, so the call is not cut mid-sentence
    if (max > TIME_WARNING_S * 2) this.timers.push(this.deps.setTimer((max - TIME_WARNING_S) * 1000, () => this.warnTimeLeft()));
    this.variables = o.variableValues ?? {};
    this.connectGemini();
  }

  /** One Gemini Live session for this call. If Gemini refuses it at once (1007), it is opened once more. */
  private connectGemini(plain = false) {
    this.gemini = this.deps.openGemini({
      onOpen: () => this.gemini?.send(JSON.stringify({
        setup: {
          model: `models/${this.deps.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.voice } } } },
          // a short pause before the AI answers; default sensitivity so a quiet caller is heard
          // the plain setting is the retry after Gemini refused the full one (1007)
          ...(plain ? {} : { realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600 } }, contextWindowCompression: { slidingWindow: {} } }),
          systemInstruction: { parts: [{ text: fillPrompt(this.deps.prompt, this.variables) }] },
          tools: geminiTools(),
        },
      })),
      onMessage: (text) => void this.fromGemini(text),
      onClose: (code) => {
        if (this.closed) return;
        if (code === 1007 && !this.retried) {
          this.retried = true;
          this.ready = false;
          if (!this.openingHeard) this.openingSpoken = false;
          this.deps.log('gemini_retry', { reason: 'refused at start' });
          this.connectGemini(true);
          return;
        }
        this.endedReason = 'gemini-closed';
        void this.hangUp();
      },
    });
  }

  /** The call cap is near: tell the AI to wrap up; its goodbye is then not held back by the end guard. */
  private warnTimeLeft() {
    if (this.closed || !this.gemini) return;
    this.refusedEnd = true;
    this.deps.log('time_nudge', { secondsLeft: TIME_WARNING_S });
    this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: TIME_NUDGE }] }], turnComplete: true } }));
  }

  /** Twilio "media": the caller's audio. */
  fromCaller(payloadB64: string) {
    if (this.ready && this.gemini && this.openingHeard) {
      const now = this.deps.now().getTime();
      const pcm = mulawToPcm16(Buffer.from(payloadB64, 'base64'));
      if (peakOf(pcm) > SPEECH_PEAK) {
        this.lastSpeechAt = now;
        this.aiWaitingSince = 0;
        this.reasks = 0;
      } else if (this.aiWaitingSince && now - this.aiWaitingSince > REASK_MS && this.reasks < 2 && !this.hangUpWhenSaid) {
        this.reasks += 1;
        this.aiWaitingSince = 0;
        this.deps.log('reask', { n: this.reasks });
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: this.reasks === 1 ? REASK : REASK_OFFER }] }], turnComplete: true } }));
      } else if (!this.nudged && now - this.lastSpeechAt > SILENCE_NUDGE_MS) {
        this.nudged = true;
        this.deps.log('silence_nudge', { silentSeconds: Math.round((now - this.lastSpeechAt) / 1000) });
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: SILENCE_NUDGE }] }], turnComplete: true } }));
      }
      this.gemini.send(JSON.stringify({ realtimeInput: { audio: { data: phoneToGemini(payloadB64), mimeType: 'audio/pcm;rate=16000' } } }));
    }
  }

  /** The AI disclosure and the recording notice come first, word for word (barber-core's opening). */
  private askOpening() {
    this.openingTries += 1;
    if (this.openingTries > 1) this.deps.log('opening_again', { tries: this.openingTries });
    this.gemini?.send(JSON.stringify({ clientContent: {
      turns: [{ role: 'user', parts: [{ text: `The call has started. Say exactly this, then wait for the caller: "${this.opening}"` }] }],
      turnComplete: true,
    } }));
  }

  /** Start-up timing: how long after Twilio's start each step came (the caller hears nothing until first_audio). */
  private step(name: string) {
    this.deps.log('start_timing', { step: name, ms: this.deps.now().getTime() - this.t0, retried: this.retried });
  }

  /** Twilio "mark": what the AI said has been fully played to the caller; the wait for an answer starts now. */
  played(name?: string) {
    if (name === 'opening' && !this.openingHeard) {
      this.openingHeard = true;
      this.step('opening_heard');
      this.aiWaitingSince = this.deps.now().getTime();
      return;
    }
    if (this.aiWaitingSince) this.aiWaitingSince = this.deps.now().getTime();
  }

  private async fromGemini(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    // Gemini says it will close the session soon (goAway): log why, so a short call can be explained
    if (m.goAway) this.deps.log('gemini_go_away', { timeLeft: String(m.goAway.timeLeft ?? '') });
    if (m.setupComplete) {
      this.step('gemini_ready');
      this.ready = true;
      this.lastSpeechAt = this.deps.now().getTime();
      if (!this.openingHeard) this.askOpening();
    }
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data) { this.aiWaitingSince = 0; this.turnAudio = true; this.openingSpoken = true; }
      if (part?.inlineData?.data && !this.firstAudio) { this.firstAudio = true; this.step('first_audio'); }
      if (part?.inlineData?.data) this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: geminiToPhone(part.inlineData.data, part.inlineData.mimeType) } }));
    }
    if (m.serverContent?.turnComplete && !this.openingHeard && !this.hangUpWhenSaid) {
      const said = this.turnAudio;
      this.turnAudio = false;
      if (!said && this.openingTries < 2) return this.askOpening(); // a turn with no audio: the opening again
      this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'opening' } }));
      this.timers.push(this.deps.setTimer(OPENING_MAX_MS, () => {
        if (this.openingHeard || this.closed) return;
        this.deps.log('opening_mark_missing', {});
        this.played('opening');
      }));
      return;
    }
    if (m.serverContent?.turnComplete) {
      this.turnAudio = false;
      this.lastSpeechAt = this.deps.now().getTime(); // the AI finished: the silence starts now
      if (!this.hangUpWhenSaid) {
        // Twilio sends the mark back once the audio is played; until then the turn's end counts
        this.aiWaitingSince = this.lastSpeechAt;
        this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'ai-turn' } }));
      }
      if (this.hangUpWhenSaid) this.timers.push(this.deps.setTimer(HANGUP_DELAY_MS, () => void this.hangUp()));
    }
    // the caller spoke over the AI: drop what Twilio still has queued (never the opening)
    if (m.serverContent?.interrupted && this.openingHeard) this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    if (m.toolCall?.functionCalls?.length) this.aiWaitingSince = 0; // a tool runs: the caller is not being asked
    if (m.toolCall?.functionCalls?.length) await this.runTools(m.toolCall.functionCalls);
  }

  private async runTools(calls: { id: string; name: string; args?: unknown }[]) {
    const responses: { id: string; name: string; response: unknown }[] = [];
    if (!this.openingSpoken) {
      // e.g. previous_visit_reminder before a word was said: the caller would wait in silence and miss the disclosure
      this.deps.log('tool_before_opening', { tools: calls.map((c) => c.name) });
      const response = { ok: false, reason: 'say_opening_first', hint: `First say the opening, word for word: "${this.opening}"` };
      this.gemini?.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response })) } }));
      return;
    }
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
        // the call is not finished yet (nothing booked, no message, no transfer): ask the AI to continue, once
        if (!this.outcome && !this.refusedEnd) {
          this.refusedEnd = true;
          this.deps.log('end_call_refused', {});
          responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'not_finished', hint: 'Ask whether the caller wants to book or leave a message before you end the call.' } });
          continue;
        }
        responses.push({ id: c.id, name: c.name, response: { ok: true } });
        this.endedReason = 'assistant-ended-call';
        // the goodbye is still being spoken: hang up only after it completes (see fromGemini)
        this.hangUpWhenSaid = true;
        this.timers.push(this.deps.setTimer(GOODBYE_MAX_MS, () => void this.hangUp()));
        continue;
      }
      if (!CORE_TOOL_NAMES.has(c.name)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'unknown_tool' } }); continue; }
      const raw = results.find((x) => x.toolCallId === c.id)?.result;
      let result: any = { ok: false, reason: 'system_error' };
      try { if (raw) result = JSON.parse(raw); } catch { /* keep system_error */ }
      this.deps.log('tool_result', { tool: c.name, ok: result?.ok === true });
      if (result?.ok === true && ['book_appointment', 'take_message', 'transfer_to_human', 'cancel_appointment', 'reschedule_appointment'].includes(c.name)) this.outcome = true;
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
    this.deps.log('call_ended', { reason: this.endedReason });
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

/** The loudest sample of 16-bit PCM audio (0 for silence). */
function peakOf(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak;
}
