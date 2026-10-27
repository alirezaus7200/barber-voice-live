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
  /** The opening as ready-made phone audio (base64 mu-law 8 kHz), word for word; null = Gemini says it. */
  speak?(text: string): Promise<string | null>;
};

const TRANSFER_DELAY_MS = 4000; // the AI says "connecting you now" first
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fa: 'Persian (Farsi)' };
const FIRST_SILENCE_NUDGE_MS = 8000; // the caller never spoke: the goodbye comes this long after the one re-ask
const RECONNECT_CODES = [1001, 1006, 1011, 1013, 1014]; // Gemini went away or failed: not our close, not a refusal
const RECONNECTED = 'The line dropped for a moment and you missed what the caller said. Apologize in one short sentence, in the caller\'s language, and ask them to repeat it.';
const WAIT_RESTART_MS = 8000; // the AI has been quiet this long with nothing running: the silence count starts again
const CALLER_PAUSE_MS = 3000; // ... once the caller has been quiet this long
const OPENING_AUDIO_WAIT_MS = 4000; // the ready-made opening is late: Gemini says it instead
const GOODBYE_MAX_MS = 15000; // safety: hang up even if the goodbye never completes
const TIME_WARNING_S = 40; // seconds before the call cap when the AI is told to wrap up (enough to take a message)
const TIME_NUDGE = 'About 40 seconds are left in this call. If the caller already chose a time: read it back and, after their yes, call book_appointment now. Never say it is booked unless book_appointment answered ok. If it cannot be finished, ask the caller: shall I connect you to the barber, or take a message for the barber? (Offer to connect them only if the salon is open now; otherwise offer only the message.) Then stop and wait for the answer. If they want a message, take it with take_message, then say a short goodbye in the caller\'s language and call end_call. Never say goodbye in the same turn as a question.';
// words that say something was booked, cancelled or moved (en, es, fa): never true before a tool said so (hard rule 8)
const DONE_CLAIM = /\b(is booked|are booked|you're booked|you are booked|booked you|is all set|has been (booked|cancel+ed|moved|rescheduled)|is cancel+ed|(qued[oó]|est[aá]|ya est[aá]) (reservad[ao]|agendad[ao]|confirmad[ao]|cancelad[ao])|ha sido (reservad[ao]|cancelad[ao]))\b|ثبت شد|رزرو شد|رزرو کردم|ثبت کردم|لغو شد|جابجا شد/i;
const FALSE_CLAIM = 'Correction: nothing has been booked, cancelled or moved in this call: no tool answered ok. Tell the caller right away, in their language, that it is not done yet. Then read the appointment back, and after their yes call book_appointment (or the tool they need). Never say it is done before the tool answers ok.';
const SILENCE_NUDGE_MS = 15000; // after both re-asks the caller still says nothing this long: the AI thanks them and ends the call
const REASK_MS = 5000; // the AI asked and the caller says nothing this long: the AI asks again (callers do not wait in silence)
const REASK = 'The caller has not answered for about 5 seconds. Say out loud now only your last question again, short, in the caller\'s language (after the opening: just "How can I help you?"). Add nothing else: never say they have not answered.';
const REASK_OFFER = 'The caller still has not answered. Ask one short question only, nothing else: if a booking is not finished, "Shall I connect you to the barber, or leave a message for them?" (offer to connect only if the salon is open now; otherwise only the message); if the booking is done, "Anything else?"; otherwise just "How can I help you?" again. Then wait for the answer.';
const MESSAGE_DONE = 'The message is passed on. If you have not told the caller yet, tell them in one short answer that the barber will get their message and get back to them, and say goodbye. If you already said it, say nothing more. Then call end_call.';
const OPENING_MAX_MS = 20000; // Twilio never confirmed the opening was played: the caller is heard anyway after this
const SPEECH_PEAK = 700; // of 32767: a voice, even on a speakerphone (quieter than a handset); above the line's hiss
const SILENCE_NUDGE = 'The caller has not answered at all. Thank them for calling, say they are welcome to call again to book their appointment, then call end_call. Say it in the caller\'s last language.';

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
  private nudged = false;
  private nudgePending = false; // the AI's next turn answers our re-ask, not the caller
  private toolAnsweredAt = 0; // when the last tool answer went to Gemini, until it speaks again
  private muted = false; // the goodbye turn is over: no more AI audio for the caller (no second goodbye)
  private aiWaitingSince = 0; // the AI finished a turn and waits for the caller (0: it does not)
  private reasks = 0; // re-asks since the AI last answered the caller (at most 2; 1 before the caller ever spoke)
  private talked = false; // the AI has answered the caller once (a conversation started)
  private plain = false; // the Gemini setting in use (plain after a 1007 at the start)
  private resumeHandle: string | null = null; // Gemini's latest handle to resume this conversation
  private reconnects = 0;
  private reconnecting = false;
  private turnText = ''; // what the AI said in this turn (transcription)
  private falseClaims = 0; // "booked" with no tool ok: corrected (at most twice a call)
  private lastAiAudioAt = 0;
  private lastLoudAt = 0;
  private toolsRunning = 0;
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
  private openingAudio: Promise<string | null> = Promise.resolve(null);
  private openingPlayed = false; // the ready-made opening went to the caller
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
      r = await this.deps.core.start(this.ids, this.deps.speak ? this.deps.voice : undefined);
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
    // barber-core keeps it once made; else it is made while Gemini connects and kept for the next calls
    if (typeof r.openingAudio === 'string' && r.openingAudio && this.deps.speak) {
      this.openingAudio = Promise.resolve(r.openingAudio);
      this.deps.log('opening_audio', { source: 'stored' });
    } else if (this.deps.speak && this.opening) {
      const text = this.opening;
      this.openingAudio = this.deps.speak(text).catch(() => null);
      void this.openingAudio.then((audio) => {
        if (!audio) return;
        this.deps.core.saveOpening(this.ids, { voice: this.deps.voice, text, audio })
          .then((x: any) => this.deps.log('opening_audio', { source: 'made', kept: x?.ok === true }))
          .catch((e: any) => this.deps.log('opening_audio_not_kept', { error: String(e?.message ?? e).slice(0, 100) }));
      });
    }
    // the salon's date and time the AI is told (no caller data), to check a wrong "tomorrow"
    this.deps.log('call_date', { now: String(this.variables.current_local_datetime ?? ''), days: String(this.variables.upcoming_days ?? '').slice(0, 120) });
    this.connectGemini();
  }

  /** One Gemini Live session for this call. If Gemini refuses it at once (1007), it is opened once more. */
  private connectGemini(plain = false) {
    this.plain = plain;
    this.gemini = this.deps.openGemini({
      onOpen: () => this.gemini?.send(JSON.stringify({
        setup: {
          model: `models/${this.deps.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.voice } } } },
          // a short pause before the AI answers; default sensitivity so a quiet caller is heard
          // the plain setting is the retry after Gemini refused the full one (1007)
          // the AI's words as text (outputAudioTranscription): to catch a "booked" no tool confirmed
          ...(plain ? {} : { realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600 } }, contextWindowCompression: { slidingWindow: {} }, outputAudioTranscription: {}, inputAudioTranscription: {} }),
          systemInstruction: { parts: [{ text: fillPrompt(this.deps.prompt, this.variables) + this.openingNote() }] },
          // Gemini sends handles to resume this conversation in a new connection (after an internal error)
          sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
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
        // Gemini dropped the connection mid-call (e.g. 1011 "Internal error"): connect again and go on,
        // with the conversation when Gemini gave a resumption handle; at most twice a call
        if (RECONNECT_CODES.includes(code ?? 0) && this.reconnects < 2) {
          this.reconnects++;
          this.ready = false;
          this.reconnecting = true;
          // the plain setting (no transcriptions, no activity settings): the full one may be what Gemini fails on
          this.deps.log('gemini_reconnect', { code, resumed: Boolean(this.resumeHandle), plain: true });
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
      // silence counts only while the AI waits for an answer (never while it thinks, runs a tool or speaks)
      // the AI is quiet, no tool runs and the caller is quiet, but no wait is counted (e.g. the AI was cut
      // off, or never answered): count again, so the line is never silent for good
      if (!this.aiWaitingSince && !this.toolsRunning && !this.hangUpWhenSaid
          && now - this.lastAiAudioAt > WAIT_RESTART_MS && now - this.lastLoudAt > CALLER_PAUSE_MS) {
        this.aiWaitingSince = now;
        this.deps.log('wait_restarted', {});
      }
      if (peakOf(pcm) > SPEECH_PEAK) {
        // a loud line (the caller, or noise and echo) pauses the count; only the AI answering resets the re-asks
        this.aiWaitingSince = 0;
        this.lastLoudAt = now;
      } else if (this.aiWaitingSince && now - this.aiWaitingSince > REASK_MS && this.reasks < this.maxReasks() && !this.hangUpWhenSaid) {
        this.reasks += 1;
        if (this.nudgePending) this.deps.log('nudge_unanswered', {}); // Gemini said nothing to the last one
        // still counting: if Gemini says nothing to this either, the next step still comes (never a silent line)
        this.aiWaitingSince = now;
        this.nudgePending = true;
        this.deps.log('reask', { n: this.reasks });
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: this.reasks === 1 ? REASK : REASK_OFFER }] }], turnComplete: true } }));
      } else if (this.aiWaitingSince && this.reasks >= this.maxReasks() && !this.nudged
                 && now - this.aiWaitingSince > (this.talked ? SILENCE_NUDGE_MS : FIRST_SILENCE_NUDGE_MS)) {
        this.nudged = true;
        this.deps.log('silence_nudge', { silentSeconds: Math.round((now - this.aiWaitingSince) / 1000) });
        this.aiWaitingSince = 0;
        this.nudgePending = true;
        // this goodbye ends the call, whether or not the AI also calls end_call: hang up once it was played
        this.endedReason = 'silence-timed-out';
        this.hangUpWhenSaid = true;
        this.timers.push(this.deps.setTimer(GOODBYE_MAX_MS, () => void this.hangUp()));
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: SILENCE_NUDGE }] }], turnComplete: true } }));
      }
      this.gemini.send(JSON.stringify({ realtimeInput: { audio: { data: phoneToGemini(payloadB64), mimeType: 'audio/pcm;rate=16000' } } }));
    }
  }

  /** The opening first, word for word: our ready-made audio if there is one, else Gemini says it. */
  private async startOpening() {
    if (!this.deps.speak && !this.openingPlayed) return this.askOpening();
    const wait = new Promise<null>((r) => this.timers.push(this.deps.setTimer(OPENING_AUDIO_WAIT_MS, () => r(null))));
    const audio = this.openingPlayed ? null : await Promise.race([this.openingAudio, wait]);
    if (this.closed || !this.gemini) return;
    if (this.openingPlayed || audio) {
      if (audio) {
        this.openingPlayed = true;
        this.openingSpoken = true;
        this.step('first_audio');
        this.firstAudio = true;
        // ~1 s pieces; Twilio plays them in order
        for (let i = 0; i < audio.length; i += 10_664) {
          this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: audio.slice(i, i + 10_664) } }));
        }
        this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'opening' } }));
        this.timers.push(this.deps.setTimer(OPENING_MAX_MS, () => {
          if (this.openingHeard || this.closed) return;
          this.deps.log('opening_mark_missing', {});
          this.played('opening');
        }));
        this.deps.log('opening_played', { source: 'tts' });
      }
      // Gemini knows from its instructions that the phone plays the opening: nothing is sent to it now
      // (a text turn here was answered as if the caller had spoken)
      this.openingSpoken = true;
      return;
    }
    this.askOpening();
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

  /** With a ready-made opening the phone plays it, not Gemini (added to its instructions at the start). */
  private openingNote(): string {
    if (!this.deps.speak || !this.opening) return '';
    return `\n\n# The opening is played for you\nThe phone system plays your opening to the caller, word for word: "${this.opening}". `
      + 'Never say it yourself, unless an instruction tells you "Say exactly this". After it, let the caller speak first; when an instruction tells you to ask or say something, say it out loud at once.';
  }

  /** The caller's language, fixed by barber-core (set_caller_language): told to Gemini in the tool's answer. */
  private languageNote(code: string): string {
    const name = LANGUAGE_NAMES[code.split('-')[0]] ?? code;
    this.deps.log('language_locked', { language: code });
    return `The caller speaks ${name}. From now on listen for ${name} and answer only in ${name}, unless the caller clearly switches to another language.`;
  }

  /** Start-up timing: how long after Twilio's start each step came (the caller hears nothing until first_audio). */
  private step(name: string) {
    this.deps.log('start_timing', { step: name, ms: this.deps.now().getTime() - this.t0, retried: this.retried });
  }

  /** The AI said something was booked (cancelled, moved) but no tool answered ok: it must correct itself now. */
  private checkClaim(text: string) {
    this.turnText = (this.turnText + text).slice(-600);
    if (this.outcome || this.falseClaims >= 2 || !DONE_CLAIM.test(this.turnText)) return;
    this.falseClaims++;
    this.turnText = '';
    this.deps.log('false_claim_corrected', {});
    // the call does not end on it: the next end_call is refused until something really happened
    this.refusedEnd = false;
    this.gemini?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: FALSE_CLAIM }] }], turnComplete: true } }));
  }

  /** Before the caller ever spoke the opening already asked "How can I help you?": one re-ask is enough. */
  private maxReasks(): number {
    return this.talked ? 2 : 1;
  }

  /** Twilio "mark": what the AI said has been fully played to the caller; the wait for an answer starts now. */
  played(name?: string) {
    if (name === 'goodbye') return void this.hangUp();
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
    if (m.sessionResumptionUpdate?.resumable && typeof m.sessionResumptionUpdate.newHandle === 'string') {
      this.resumeHandle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.setupComplete) {
      this.step('gemini_ready');
      this.ready = true;
      if (this.reconnecting) {
        this.reconnecting = false;
        this.aiWaitingSince = this.deps.now().getTime();
        // a fresh conversation (no handle): the AI knows only its instructions, so it asks the caller to repeat
        if (!this.resumeHandle && this.openingHeard) {
          this.gemini?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: RECONNECTED }] }], turnComplete: true } }));
        }
      }
      if (!this.openingHeard) void this.startOpening();
    }
    // Gemini heard the caller (inputAudioTranscription): they answered, even if too quietly for our meter,
    // so no re-ask now (a re-ask after an answer made the AI repeat its question)
    const heard = m.serverContent?.inputTranscription?.text;
    if (typeof heard === 'string' && heard.trim()) {
      this.aiWaitingSince = 0;
      this.lastLoudAt = this.deps.now().getTime();
    }
    const said = m.serverContent?.outputTranscription?.text;
    if (typeof said === 'string' && said) this.checkClaim(said);
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data && this.muted) continue;
      if (part?.inlineData?.data) {
        this.lastAiAudioAt = this.deps.now().getTime();
        this.aiWaitingSince = 0;
        this.turnAudio = true;
        this.openingSpoken = true;
        if (!this.nudgePending) { this.reasks = 0; if (this.openingHeard) this.talked = true; }
        if (this.toolAnsweredAt) {
          this.deps.log('gemini_reply', { ms: this.deps.now().getTime() - this.toolAnsweredAt });
          this.toolAnsweredAt = 0;
        } // the AI answers the caller (who may speak too quietly for the meter)
      }
      if (part?.inlineData?.data && !this.firstAudio) { this.firstAudio = true; this.step('first_audio'); }
      if (part?.inlineData?.data) {
        const payload = geminiToPhone(part.inlineData.data, part.inlineData.mimeType);
        this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload } }));
      }
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
      this.turnText = '';
      this.turnAudio = false;
      this.nudgePending = false;
      if (!this.hangUpWhenSaid) {
        // Twilio sends the mark back once the audio is played; until then the turn's end counts
        this.aiWaitingSince = this.deps.now().getTime(); // the AI finished: the wait for an answer starts now
        this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'ai-turn' } }));
      }
      if (this.hangUpWhenSaid && !this.muted) {
        // the goodbye turn is over: nothing more is played; hang up when Twilio has played the goodbye
        this.muted = true;
        this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'goodbye' } }));
      }
    }
    // the caller spoke over the AI: drop what Twilio still has queued (never the opening)
    if (m.serverContent?.interrupted && this.openingHeard) {
      this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
    if (m.toolCall?.functionCalls?.length) this.aiWaitingSince = 0; // a tool runs: the caller is not being asked
    if (m.toolCall?.functionCalls?.length) await this.runTools(m.toolCall.functionCalls);
  }

  private async runTools(calls: { id: string; name: string; args?: unknown }[]) {
    this.toolsRunning++;
    try {
      await this.runToolsNow(calls);
    } finally {
      this.toolsRunning--;
      this.lastAiAudioAt = this.deps.now().getTime(); // Gemini now answers the tool: give it time to speak
    }
  }

  private async runToolsNow(calls: { id: string; name: string; args?: unknown }[]) {
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
        const t = this.deps.now().getTime();
        results = await this.deps.core.tools(this.ids, forCore.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
        // how long barber-core took (a long pause in a call is either this or gemini_reply)
        this.deps.log('tool_timing', { tools: forCore.map((c) => c.name), ms: this.deps.now().getTime() - t });
      } catch (e: any) {
        this.deps.log('core_tools_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
      }
    }
    for (const c of calls) {
      if (c.name === 'end_call') {
        // the call is not finished yet (nothing booked, no message, no transfer): ask the AI to continue, once
        // (never after the silence goodbye: that one ends the call on purpose)
        if (!this.outcome && !this.refusedEnd && !this.hangUpWhenSaid) {
          this.refusedEnd = true;
          this.deps.log('end_call_refused', {});
          responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'not_finished', hint: 'Ask whether the caller wants to book or leave a message before you end the call.' } });
          continue;
        }
        this.endedReason = 'assistant-ended-call';
        // the goodbye may still be streaming (end_call can come mid-sentence): it is never cut; the call ends
        // once this turn is over and Twilio has played it (see fromGemini and played)
        const note = this.turnAudio ? 'The goodbye was said. Say nothing more.' : 'Say one short goodbye now, and nothing else.';
        responses.push({ id: c.id, name: c.name, response: { ok: true, note } });
        this.hangUpWhenSaid = true;
        this.timers.push(this.deps.setTimer(GOODBYE_MAX_MS, () => void this.hangUp()));
        continue;
      }
      if (!CORE_TOOL_NAMES.has(c.name)) { responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'unknown_tool' } }); continue; }
      const raw = results.find((x) => x.toolCallId === c.id)?.result;
      let result: any = { ok: false, reason: 'system_error' };
      try { if (raw) result = JSON.parse(raw); } catch { /* keep system_error */ }
      // the reason code only (e.g. slot_taken), never the arguments or the caller's data
      this.deps.log('tool_result', { tool: c.name, ok: result?.ok === true, ...(result?.ok === true ? {} : { reason: String(result?.reason ?? '').slice(0, 40) }) });
      if (result?.ok === true && ['book_appointment', 'take_message', 'transfer_to_human', 'cancel_appointment', 'reschedule_appointment'].includes(c.name)) this.outcome = true;
      // the call's language is fixed: Gemini listens for it and answers only in it from now on
      if (c.name === 'set_caller_language' && result?.ok === true && typeof result.language === 'string') result = { ...result, next: this.languageNote(result.language) };
      // a message is passed on: only now the caller hears so, then one goodbye (never a goodbye first)
      if (c.name === 'take_message' && result?.ok === true && !calls.some((x) => x.name === 'end_call')) result = { ...result, next: MESSAGE_DONE };
      responses.push({ id: c.id, name: c.name, response: result });
      // barber-core said a person can take the call now (only while the salon is open): move it there
      if (c.name === 'transfer_to_human' && result?.ok === true && typeof result.transfer_to === 'string') {
        const twiml = dialTwiml(result.transfer_to, this.ids.from);
        if (twiml) this.timers.push(this.deps.setTimer(TRANSFER_DELAY_MS, () => void this.handOff(twiml, 'assistant-forwarded-call')));
      }
    }
    this.gemini?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    this.toolAnsweredAt = this.deps.now().getTime();
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
