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
  openGemini(handlers: { onOpen(): void; onMessage(text: string): void; onClose(code?: number, reason?: string): void }): SocketLike;
  /** Replaces what the live call does (Twilio REST): a transfer, a notice, a hang-up. */
  updateCall(callSid: string, twiml: string): Promise<{ ok: boolean; error?: string }>;
  prompt: string;
  model: string;
  /** Gemini's start-of-speech settings (from Cloud Run's settings); unset = Gemini's own. */
  activity?: { startOfSpeechSensitivity?: string; prefixPaddingMs?: number };
  /** This server marks the caller's turns (activityStart/activityEnd) instead of Gemini's own detection. */
  ourTurns?: boolean;
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
const WAIT_RESTART_MS = 8000; // the AI has been quiet this long with nothing running: the silence count starts again
const CALLER_PAUSE_MS = 3000; // ... once the caller has been quiet this long
const OPENING_AUDIO_WAIT_MS = 4000; // the ready-made opening is late: Gemini says it instead
const GOODBYE_MAX_MS = 15000; // safety: hang up even if the goodbye never completes
const TIME_WARNING_S = 40; // seconds before the call cap when the AI is told to wrap up (enough to take a message)
const TIME_NUDGE = 'About 40 seconds are left in this call. If the caller already chose a time: read it back and, after their yes, call book_appointment now. Never say it is booked unless book_appointment answered ok. If it cannot be finished, ask the caller: shall I connect you to the barber, or take a message for the barber? (Offer to connect them only if the salon is open now; otherwise offer only the message.) Then stop and wait for the answer. If they want a message, take it with take_message, then say a short goodbye in the caller\'s language and call end_call. Never say goodbye in the same turn as a question.';
// words that say something was booked, cancelled or moved (en, es, fa): never true before a tool said so (hard rule 8)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many characters differ between two ids of the same length. */
const charsOff = (a: string, b: string) => [...a].reduce((n, ch, i) => n + (ch === b[i] ? 0 : 1), 0);
const CLAIM_WAIT_MS = 3000; // a "booked" claim is corrected only if no tool made it true by then
const GOODBYE = /خدانگهدار|خداحافظ|\bgood ?bye\b|\bbye\b|adi[oó]s|hasta (luego|pronto)/i;
const DONE_CLAIM = /\b(is booked|are booked|you're booked|you are booked|booked you|is all set|has been (booked|cancel+ed|moved|rescheduled)|is cancel+ed|(qued[oó]|est[aá]|ya est[aá]) (reservad[ao]|agendad[ao]|confirmad[ao]|cancelad[ao])|ha sido (reservad[ao]|cancelad[ao]))\b|ثبت شد|رزرو شد|رزرو کردم|ثبت کردم|لغو شد|جابجا شد|انجام شد/i;
const FALSE_CLAIM = 'Correction: nothing has been booked, cancelled or moved in this call: no tool answered ok. Tell the caller right away, in their language, that it is not done yet. Then read the appointment back, and after their yes call book_appointment (or the tool they need). Never say it is done before the tool answers ok.';
// a time of day said out loud (en, es, fa): an offer of times is only real after check_availability answered
const TIME_SAID = /\b\d{1,2}[:.]\d{2}\b|[۰-۹]{1,2}[:٫][۰-۹]{2}|\b\d{1,2}\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|ساعت\s*([\d۰-۹]|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده)|\ba las (\d|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/i;
const UNCHECKED_TIMES = 'Correction: the times you just said did not come from check_availability (it has not answered in this call), so they may not be free. Tell the caller in one short sentence, in their language, that you will check, then call check_availability now and offer only the times it returns.';
// Our own turns (GEMINI_TURNS=ours): a turn starts when the caller's voice is clearly above the line's hiss (a
// louder one while the AI's words are still playing at the caller, so its echo does not cut it off), with the last
// ~200 ms before it, and ends after 700 ms of quiet; Gemini then answers every turn, however short («بله»).
// "Still playing" is the audio sent to Twilio, by its length (not Gemini's turn, which also lasts through tools):
// at 4000 while the whole turn counted, a quick «برای فردا می‌خوام» right after the question never reached Gemini.
const TURN_START_PEAK = 1500;
const TURN_START_PEAK_OVER_AI = 2500;
const TURN_END_QUIET_MS = 700;
const TURN_PREROLL_FRAMES = 10; // Twilio sends 20 ms frames
// book_appointment only after the read-back (hard rule): the AI's last turn before it must have said the chosen time,
// as check_availability gave it, and asked if it is right; else it is told to read back first (once a call)
const NOT_OFFERED = 'Not booked yet: check_availability did not give that time. Call check_availability for that day with earliest_time set to it; use only a start_iso it returns, read it back, and book after a clear yes.';
const READ_BACK_WAIT = 'Not done yet: you asked "Is that right?" and called the tool in the same breath. Say nothing more now and never say it is done; wait for the caller\'s answer, and only after a clear yes call the same tool again.';
const READ_BACK_FIRST = 'Not booked yet. First read it all back in one sentence (staff member, services, weekday, date, time and the name) and ask "Is that right?"; call book_appointment again only after a clear yes.';
// cancel_appointment only after the caller said yes to that one appointment: the list of their appointments
// («…کدوم رو می‌خواید لغو کنید؟») is not that question, unless it had only one (once a call)
const CONFIRM_CANCEL = 'Not cancelled yet. First ask about that one appointment, in one sentence with its day, time and staff member ("Shall I cancel your Friday 2:30 PM with Erfan?"); call cancel_appointment again only after a clear yes.';
// end_call while the caller has not answered the AI's last question ("Anything else? Goodbye."): wait (twice a call at most)
const WAIT_FOR_ANSWER = 'You asked the caller a question and they have not answered yet. Say nothing more now; wait for their answer.';
const SILENCE_NUDGE_MS = 15000; // after both re-asks the caller still says nothing this long: the AI thanks them and ends the call
const REASK_MS = 5000; // the AI asked and the caller says nothing this long: the AI asks again (callers do not wait in silence)
// the re-asks and the silence goodbye name the call's language: a caller who never spoke gave none, and the AI then
// fell back to English in a Persian call
const REASK = (lang: string) => `The caller has not answered for about 5 seconds. Say out loud now only your last question again, short, in ${lang} (after the opening: just "How can I help you?", said in ${lang}). Add nothing else: never say they have not answered.`;
// the second re-ask: the caller may have answered too quietly to be heard, so the same question again in other
// words; "connect or message" only when a tool already said no (a re-ask mid-booking is not a failed booking)
const REASK_OFFER = (lang: string) => `Speak ${lang}. The caller still has not answered. If they already said yes to your read-back, call book_appointment now instead. Otherwise ask your last question once more, in other short words, and give the choices (for the day: "Today, tomorrow, or another day?" / «امروز، فردا، یا روز دیگه؟»), nothing else. Only if a tool already said this booking cannot be done, ask instead: "Shall I connect you to the barber, or leave a message for them?" (offer to connect only if the salon is open now; otherwise only the message). If the booking is done, just "Anything else?". Then wait for the answer.`;
const MESSAGE_DONE = 'The message is passed on. If you have not told the caller yet, tell them in one short answer that the barber will get their message and get back to them, and say goodbye. If you already said it, say nothing more. Then call end_call.';
const OPENING_MAX_MS = 20000; // Twilio never confirmed the opening was played: the caller is heard anyway after this
const SPEECH_PEAK = 700; // of 32767: a voice, even on a speakerphone (quieter than a handset); above the line's hiss
const SILENCE_NUDGE = (lang: string) => `The caller has not answered at all. Thank them for calling, say they are welcome to call again to book their appointment, then call end_call. Say it in ${lang}.`;

// What the phone server did that also goes into the call's text (barber-core keeps it for the superadmins)
const NOTE_EVENTS = new Set(['reask', 'silence_nudge', 'time_nudge', 'false_claim_corrected', 'unchecked_times_corrected',
  'end_call_refused', 'language_locked', 'gemini_retry', 'gemini_go_away', 'core_tools_failed', 'tool_unknown',
  'tool_before_opening', 'opening_again', 'twilio_update_failed', 'call_ended', 'gemini_setup', 'repeat_muted',
  'cancel_confirm_missing', 'read_back_missing', 'appointment_id_unknown', 'appointment_id_guessed', 'id_corrected',
  // the timings, so a long pause in a call can be explained from its text: barber-core's tools, Gemini's answer,
  // the silence count starting again, a nudge Gemini did not answer
  'tool_timing', 'gemini_reply', 'wait_restarted', 'nudge_unanswered']);
const TRANSCRIPT_MAX_CHARS = 200_000; // a long call's text stays a small report
type TranscriptLine = { speaker: 'ai' | 'caller' | 'tool' | 'system'; body: string; at_ms: number };

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
  private turnText = ''; // what the AI said in this turn (output transcription)
  private claimText = ''; // this turn's words since the last false claim was corrected
  private turnTool = false; // the AI asked for a tool in this turn
  private lockedLanguage: string | null = null; // the caller's language, once set_caller_language fixed it
  private muteRestOfTurn = false; // the AI asked its question, then set the language: the rest of this turn is its repeat
  private lastTurns: string[] = []; // the AI's last finished turns, as text
  private slotWords = new Map<string, string[]>(); // a free time (start_iso) as check_availability said it
  private readBackRefused = 0;
  private notOfferedRefused = 0;
  private knownIds = new Set<string>(); // every id this call was given (the salon's facts, tool answers)
  private readBackFor = new Set<number>(); // times the AI already read back with a question (an earlier turn counts too)
  private bookAfterListRefused = 0;
  private listingPending = false; // find_my_appointments answered: the AI's turn now lists them
  private listText = ''; // that turn's words (the list, not the confirmation)
  private apptCount = 0;
  private cancelRefused = 0;
  private apptIds = new Map<string, string>(); // the caller's appointments this call found: short name (appt-1) -> its time
  private apptAlias = new Map<string, string>(); // short name -> barber-core's id (Gemini cannot copy a long id: it made them up)
  private badIdTold = 0;
  private askedAt = 0; // when the AI last asked something (a ? in its words)
  private callerAt = 0; // when the caller last said something
  private endRefusedForQuestion = 0;
  private falseClaims = 0; // "booked" with no tool ok: corrected (at most twice a call)
  private claimPending = false; // this turn said "booked": checked once the turn is over (the tool often comes after the words)
  private timesChecked = false; // check_availability (or find_my_appointments) answered ok in this call
  private uncheckedTimes = 0; // times offered before any check: corrected (at most twice a call)
  private lastAiAudioAt = 0;
  private lastLoudAt = 0;
  // the call's text, in order: the AI's and the caller's words (Gemini's transcriptions), tools, the server's notes
  private transcript: TranscriptLine[] = [];
  private transcriptChars = 0;
  private aiLine: TranscriptLine | null = null; // the AI's turn being written down
  private callerLine: TranscriptLine | null = null; // the caller's words since the AI last finished a turn
  private playingUntil = 0; // when the AI audio already sent to Twilio ends playing at the caller (ms)
  private ourTurns = false; // this call marks the caller's turns itself (not on the plain retry)
  private inTurn = false;
  private turnQuietSince = 0;
  private preroll: string[] = [];
  private turnsSent = 0;
  private callerPeak = 0; // the caller's loudest frame since the AI last finished a turn (of 32767)
  private heardChars = 0; // how much Gemini wrote down of the caller since then (a count only, never the words)
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
      this.log('core_start_failed', { call: p.callSid, error: String(e?.message ?? e) });
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
      this.log('opening_audio', { source: 'stored' });
    } else if (this.deps.speak && this.opening) {
      const text = this.opening;
      this.openingAudio = this.deps.speak(text).catch(() => null);
      void this.openingAudio.then((audio) => {
        if (!audio) return;
        this.deps.core.saveOpening(this.ids, { voice: this.deps.voice, text, audio })
          .then((x: any) => this.log('opening_audio', { source: 'made', kept: x?.ok === true }))
          .catch((e: any) => this.log('opening_audio_not_kept', { error: String(e?.message ?? e).slice(0, 100) }));
      });
    }
    // the salon's date and time the AI is told (no caller data), to check a wrong "tomorrow"
    this.log('call_date', { now: String(this.variables.current_local_datetime ?? ''), days: String(this.variables.upcoming_days ?? '').slice(0, 120) });
    this.connectGemini();
  }

  /** One Gemini Live session for this call. If Gemini refuses it at once (1007), it is opened once more. */
  private connectGemini(plain = false) {
    // which hearing settings this call used: in its text, so a test result says which one passed
    this.ourTurns = this.deps.ourTurns === true && !plain;
    this.log('gemini_setup', { model: this.deps.model, plain, ...this.deps.activity, ...(this.ourTurns ? { turns: 'ours' } : {}) });
    this.gemini = this.deps.openGemini({
      onOpen: () => this.gemini?.send(JSON.stringify({
        setup: {
          model: `models/${this.deps.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.voice } } } },
          // a short pause before the AI answers; default sensitivity so a quiet caller is heard
          // the plain setting is the retry after Gemini refused the full one (1007)
          // the AI's words as text (outputAudioTranscription): to catch a "booked" or times no tool gave
          ...(plain ? {} : { realtimeInputConfig: { automaticActivityDetection: this.ourTurns ? { disabled: true } : { silenceDurationMs: 600, ...this.deps.activity } }, contextWindowCompression: { slidingWindow: {} }, inputAudioTranscription: {}, outputAudioTranscription: {} }),
          systemInstruction: { parts: [{ text: this.learnIds(fillPrompt(this.deps.prompt, this.variables)) + this.openingNote() }] },
          tools: geminiTools(),
        },
      })),
      onMessage: (text) => void this.fromGemini(text),
      onClose: (code, reason) => {
        if (this.closed) return;
        // Gemini's own close code and reason in the call's text too (1000 normal; 1007 refused; 1011 its own error)
        this.line('system', `gemini_closed ${JSON.stringify({ code: code ?? null, reason: String(reason ?? '').slice(0, 200) })}`);
        if (code === 1007 && !this.retried) {
          this.retried = true;
          this.ready = false;
          if (!this.openingHeard) this.openingSpoken = false;
          this.log('gemini_retry', { reason: 'refused at start' });
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
    this.log('time_nudge', { secondsLeft: TIME_WARNING_S });
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
        this.log('wait_restarted', {});
      }
      const peak = peakOf(pcm);
      if (peak > this.callerPeak) this.callerPeak = peak;
      if (peak > SPEECH_PEAK) {
        // a loud line (the caller, or noise and echo) pauses the count; only the AI answering resets the re-asks
        this.aiWaitingSince = 0;
        this.lastLoudAt = now;
      } else if (this.aiWaitingSince && now - this.aiWaitingSince > REASK_MS && this.reasks < this.maxReasks() && !this.hangUpWhenSaid) {
        this.reasks += 1;
        if (this.nudgePending) this.log('nudge_unanswered', {}); // Gemini said nothing to the last one
        // still counting: if Gemini says nothing to this either, the next step still comes (never a silent line)
        this.aiWaitingSince = now;
        this.nudgePending = true;
        // loudMsAgo: how long ago the line was last loud (the caller may have answered and Gemini missed it)
        this.log('reask', { n: this.reasks, loudMsAgo: this.lastLoudAt ? Math.min(now - this.lastLoudAt, 99999) : -1, callerPeak: this.callerPeak, heardChars: this.heardChars, ...(this.ourTurns ? { turnsSent: this.turnsSent } : {}) });
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: this.reasks === 1 ? REASK(this.callLanguageName()) : REASK_OFFER(this.callLanguageName()) }] }], turnComplete: true } }));
      } else if (this.aiWaitingSince && this.reasks >= this.maxReasks() && !this.nudged
                 && now - this.aiWaitingSince > (this.talked ? SILENCE_NUDGE_MS : FIRST_SILENCE_NUDGE_MS)) {
        this.nudged = true;
        this.log('silence_nudge', { silentSeconds: Math.round((now - this.aiWaitingSince) / 1000), callerPeak: this.callerPeak, heardChars: this.heardChars });
        this.aiWaitingSince = 0;
        this.nudgePending = true;
        // this goodbye ends the call, whether or not the AI also calls end_call: hang up once it was played
        this.endedReason = 'silence-timed-out';
        this.hangUpWhenSaid = true;
        this.timers.push(this.deps.setTimer(GOODBYE_MAX_MS, () => void this.hangUp()));
        this.gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: SILENCE_NUDGE(this.callLanguageName()) }] }], turnComplete: true } }));
      }
      const audio = phoneToGemini(payloadB64);
      if (this.ourTurns) this.markTurn(audio, peak, now);
      else this.sendAudio(audio);
    }
  }

  private sendAudio(data: string) {
    this.gemini?.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
  }

  /** Our own turns: start on a clear voice (with the ~200 ms before it), end after a short quiet; Gemini answers each one. */
  private markTurn(audio: string, peak: number, now: number) {
    if (!this.inTurn) {
      this.preroll.push(audio);
      if (this.preroll.length > TURN_PREROLL_FRAMES) this.preroll.shift();
      const aiTalking = now < this.playingUntil;
      if (peak <= (aiTalking ? TURN_START_PEAK_OVER_AI : TURN_START_PEAK)) return;
      this.inTurn = true;
      this.turnQuietSince = 0;
      this.gemini?.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      for (const a of this.preroll) this.sendAudio(a);
      this.preroll = [];
      return;
    }
    this.sendAudio(audio);
    if (peak > SPEECH_PEAK) { this.turnQuietSince = 0; return; }
    if (!this.turnQuietSince) { this.turnQuietSince = now; return; }
    if (now - this.turnQuietSince < TURN_END_QUIET_MS) return;
    this.gemini?.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.callerAt = now;
    this.inTurn = false;
    this.turnQuietSince = 0;
    this.turnsSent += 1;
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
        this.line('ai', this.opening); // our ready-made audio: Gemini did not say it, so it has no transcription
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
          this.log('opening_mark_missing', {});
          this.played('opening');
        }));
        this.log('opening_played', { source: 'tts' });
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
    if (this.openingTries > 1) this.log('opening_again', { tries: this.openingTries });
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
  /** The call's language by name: the one the caller was heard in, else the salon's own (the opening's). */
  private callLanguageName(): string {
    const code = this.lockedLanguage ?? String(this.variables.default_language ?? 'en');
    return LANGUAGE_NAMES[code.split('-')[0]] ?? code;
  }

  private languageNote(code: string): string {
    this.lockedLanguage = code;
    const name = LANGUAGE_NAMES[code.split('-')[0]] ?? code;
    this.log('language_locked', { language: code });
    return `The caller speaks ${name}. From now on listen for ${name} and answer only in ${name}, unless the caller clearly switches to another language. Say nothing more now: no new question and nothing you already said. If you asked a question, wait silently for the caller's answer.`;
  }

  /** Start-up timing: how long after Twilio's start each step came (the caller hears nothing until first_audio). */
  private step(name: string) {
    this.log('start_timing', { step: name, ms: this.deps.now().getTime() - this.t0, retried: this.retried });
  }

  private log(event: string, data: Record<string, unknown>) {
    this.deps.log(event, data);
    if (NOTE_EVENTS.has(event)) this.line('system', `${event} ${JSON.stringify(data)}`);
  }

  /** A new line of the call's text (none once the text is long enough). */
  private line(speaker: TranscriptLine['speaker'], body: string): TranscriptLine | null {
    const text = body.slice(0, 2000); // pieces keep their spaces; the report trims each line
    if (!text.trim() || this.transcriptChars + text.length > TRANSCRIPT_MAX_CHARS || this.transcript.length >= 2000) return null;
    const l = { speaker, body: text, at_ms: Math.max(0, this.deps.now().getTime() - (this.t0 || this.deps.now().getTime())) };
    this.transcript.push(l);
    this.transcriptChars += text.length;
    return l;
  }

  /** More words of the AI's or the caller's current line (Gemini sends them in pieces). */
  private words(speaker: 'ai' | 'caller', piece: string) {
    const open = speaker === 'ai' ? this.aiLine : this.callerLine;
    if (open) {
      const room = Math.min(2000 - open.body.length, TRANSCRIPT_MAX_CHARS - this.transcriptChars);
      const add = piece.slice(0, Math.max(0, room));
      open.body += add;
      this.transcriptChars += add.length;
      return;
    }
    const l = this.line(speaker, piece);
    if (speaker === 'ai') this.aiLine = l; else this.callerLine = l;
  }

  /** The caller's last visit, looked up here right after the opening (the AI said "one moment" before the tool). */
  private async previousVisit() {
    let res: any = null;
    try {
      const r = await this.deps.core.tools(this.ids, [{ id: 'previous-visit', name: 'previous_visit_reminder', args: {} }]);
      res = JSON.parse(r.find((x) => x.toolCallId === 'previous-visit')?.result ?? 'null');
    } catch { /* no reminder: the call goes on */ }
    if (!res) return;
    this.log('tool_result', { tool: 'previous_visit_reminder', ok: res.ok === true, ...(res.remind === true ? { remind: true } : {}) });
    this.line('tool', `previous_visit_reminder → ${JSON.stringify(res).slice(0, 500)}`);
    if (this.closed || res.ok !== true || res.remind !== true || typeof res.spoken !== 'string' || !res.spoken.trim()) return;
    const spoken = res.spoken.replace(/["\\]/g, ' ').slice(0, 300);
    this.gemini?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: `Note from the phone system: say this to the caller now, exactly, in one short turn: "${spoken}". If they already asked for something, answer that instead and leave this out.` }] }], turnComplete: true } }));
  }

  /** How each offered time was said (the tool's words, and the usual shorter forms), to find it in the read-back. */
  private rememberSlots(slots: any[]) {
    for (const s of slots) {
      if (typeof s?.start_iso !== 'string') continue;
      const said = [s.spoken, s.spoken_en, s.spoken_es, s.local_time].filter((w): w is string => typeof w === 'string' && w.trim() !== '');
      const short = said.flatMap((w) => [w.replace(/^ساعت\s*/, ''), w.replace(/^las\s*/, ''), w.replace(':00 ', ' ')]);
      this.slotWords.set(s.start_iso, [...new Set([...said, ...short].map((w) => w.trim()).filter((w) => w.length > 1))]);
    }
  }

  /** The caller was asked about the one appointment to cancel: the AI's last turn is a question, and not the list of
   *  their appointments (unless there was only one, which that question names). */
  private cancelConfirmed(): boolean {
    const last = this.lastTurns.at(-1) ?? '';
    if (!/[?؟]/.test(last)) return false;
    return last !== this.listText || this.apptCount === 1;
  }

  /** A booking after find_my_appointments: a move is reschedule_appointment (it frees the old time). */
  private moveNotBookHint(): string {
    const list = [...this.apptIds].map(([i, t]) => `${i} (${t})`).join(', ');
    return `Not booked yet. The caller already has ${list}. If they want to move one, call reschedule_appointment with its appointment_id and this time as new_start_iso, and tell them it was moved: book_appointment would keep the old one too. Call book_appointment again only if they clearly want one more appointment besides it.`;
  }

  /** Remembers every id in a text (the facts, a tool's answer); returns the text. */
  private learnIds(text: string): string {
    for (const m of text.matchAll(UUID_RE)) this.knownIds.add(m[0].toLowerCase());
    return text;
  }

  /** A staff or service id one or two characters off one this call was given is that one: Gemini copied
   *  «10b40df1-…» as «10b40df0-…» and the booking failed with unknown_service. barber-core still checks it. */
  private fixIds(c: { name: string; args?: unknown }) {
    const args = c.args as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object' || !this.knownIds.size) return;
    const fix = (v: unknown) => {
      if (typeof v !== 'string' || !UUID_ONE.test(v) || this.knownIds.has(v.toLowerCase())) return v;
      const near = [...this.knownIds].filter((k) => charsOff(k, v.toLowerCase()) <= 2);
      if (near.length !== 1) return v;
      this.log('id_corrected', { tool: c.name });
      return near[0];
    };
    if ('staff_id' in args) args.staff_id = fix(args.staff_id);
    if (Array.isArray(args.service_ids)) args.service_ids = args.service_ids.map(fix);
  }

  /** check_availability gave this start in this call (the same instant, however it is written). */
  private offered(start: unknown): boolean {
    const t = typeof start === 'string' ? Date.parse(start) : NaN;
    if (Number.isNaN(t)) return true; // not a time: barber-core answers invalid_input
    return [...this.slotWords.keys()].some((iso) => Date.parse(iso) === t);
  }

  /** The AI's last finished turn read the booking back: it said the chosen time and asked if it is right. */
  private readBackDone(start: unknown): boolean {
    if (typeof start !== 'string') return true;
    if (this.readBackFor.has(Date.parse(start))) return true;
    return this.readBackIn(start, this.lastTurns.at(-1) ?? '');
  }

  /** This AI turn read the booking back: it said that time (and no other offered one) and asked if it is right. */
  private readBackIn(start: string, last: string): boolean {
    const t = Date.parse(start);
    const key = [...this.slotWords.keys()].find((iso) => iso === start || Date.parse(iso) === t) ?? start;
    const words = this.slotWords.get(key);
    if (!words?.length) return true; // a time this call did not offer (nothing to compare): the database still checks it
    if (!/[?؟]/.test(last) || !words.some((w) => last.includes(w))) return false;
    // the offer itself («…نه و نیم صبح، دو بعد از ظهر یا شش و نیم عصر… کدوم؟») has the chosen time and a question
    // too: a read-back names only the chosen time, never another one that was offered
    const others = [...this.slotWords.entries()].filter(([iso]) => iso !== key).map(([, w]) => w[0])
      .filter((w) => w && !words.some((own) => own.includes(w)));
    return !others.some((w) => last.includes(w));
  }

  /** The AI said something was booked (cancelled, moved) but no tool answered ok: it must correct itself now. */
  private checkClaim(text: string) {
    this.turnText = (this.turnText + text).slice(-600);
    this.claimText = (this.claimText + text).slice(-600);
    if (this.outcome || this.falseClaims >= 2 || !DONE_CLAIM.test(this.claimText)) return;
    this.claimText = ''; // the turn keeps its words (a read-back in it still counts)
    // the call does not end on it: the next end_call is refused until something really happened
    this.refusedEnd = false;
    this.claimPending = true;
  }

  /** The turn that said "booked" is over: if no tool made it true (or is still running) a little later, correct it.
   *  Gemini says «ثبت شد» and calls book_appointment seconds after: correcting at once made it say «هنوز ثبت نشده»
   *  after the booking had gone through, and book again. */
  private claimTurnOver() {
    if (!this.claimPending) return;
    this.claimPending = false;
    this.timers.push(this.deps.setTimer(CLAIM_WAIT_MS, () => {
      if (this.closed || this.outcome || this.toolsRunning || this.falseClaims >= 2) return;
      this.falseClaims++;
      this.log('false_claim_corrected', {});
      this.gemini?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: FALSE_CLAIM }] }], turnComplete: true } }));
    }));
  }

  /** A turn that said times of day before check_availability ever answered (and asked for no tool): they are made up. */
  private checkTimes() {
    if (this.timesChecked || this.turnTool || this.toolsRunning || this.uncheckedTimes >= 2 || !TIME_SAID.test(this.turnText)) return;
    this.uncheckedTimes++;
    this.log('unchecked_times_corrected', {});
    this.gemini?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: UNCHECKED_TIMES }] }], turnComplete: true } }));
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
      void this.previousVisit();
      return;
    }
    if (this.aiWaitingSince) this.aiWaitingSince = this.deps.now().getTime();
  }

  private async fromGemini(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    // Gemini says it will close the session soon (goAway): log why, so a short call can be explained
    if (m.goAway) this.log('gemini_go_away', { timeLeft: String(m.goAway.timeLeft ?? '') });
    // Gemini heard the caller (inputAudioTranscription): they answered, even if too quietly for our meter, so no
    // re-ask now (a re-ask over a quiet "yes" made the AI ask again, or offer a message instead of booking)
    const heardText = m.serverContent?.inputTranscription?.text;
    if (typeof heardText === 'string') this.heardChars += heardText.trim().length;
    if (typeof heardText === 'string' && heardText.trim()) { this.words('caller', heardText); this.callerAt = this.deps.now().getTime(); }
    if (typeof heardText === 'string' && heardText.trim()) {
      this.aiWaitingSince = 0;
      this.lastLoudAt = this.deps.now().getTime();
    }
    if (m.setupComplete) {
      this.step('gemini_ready');
      this.ready = true;
      if (!this.openingHeard) void this.startOpening();
    }
    const said = m.serverContent?.outputTranscription?.text;
    if (typeof said === 'string' && said && !this.muteRestOfTurn) { this.checkClaim(said); this.words('ai', said); if (/[?؟]/.test(said)) this.askedAt = this.deps.now().getTime(); }
    if (m.serverContent?.interrupted) this.aiLine = null;
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data && (this.muted || this.muteRestOfTurn)) continue;
      if (part?.inlineData?.data) {
        this.lastAiAudioAt = this.deps.now().getTime();
        this.aiWaitingSince = 0;
        // how loud the caller was and how much Gemini wrote down before this answer: a quiet line shows here
        if (!this.turnAudio && this.openingHeard) this.log('caller_turn', { callerPeak: this.callerPeak, heardChars: this.heardChars });
        this.turnAudio = true;
        this.openingSpoken = true;
        if (!this.nudgePending) { this.reasks = 0; if (this.openingHeard) this.talked = true; }
        if (this.toolAnsweredAt) {
          this.log('gemini_reply', { ms: this.deps.now().getTime() - this.toolAnsweredAt });
          this.toolAnsweredAt = 0;
        } // the AI answers the caller (who may speak too quietly for the meter)
      }
      if (part?.inlineData?.data && !this.firstAudio) { this.firstAudio = true; this.step('first_audio'); }
      if (part?.inlineData?.data) {
        const payload = geminiToPhone(part.inlineData.data, part.inlineData.mimeType);
        // mu-law 8 kHz: one byte is 1/8 ms; base64 is 4 characters for 3 bytes
        const ms = (payload.length * 3) / 4 / 8;
        const t = this.deps.now().getTime();
        this.playingUntil = Math.max(this.playingUntil, t) + ms;
        this.twilio.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload } }));
      }
    }
    // a turn is over: the next words are new lines (the caller's late words before it still join their line)
    if (m.serverContent?.turnComplete) { this.aiLine = null; this.callerLine = null; }
    if (m.serverContent?.turnComplete && !this.openingHeard && !this.hangUpWhenSaid) {
      const said = this.turnAudio;
      this.turnAudio = false;
      if (!said && this.openingTries < 2) return this.askOpening(); // a turn with no audio: the opening again
      this.twilio.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'opening' } }));
      this.timers.push(this.deps.setTimer(OPENING_MAX_MS, () => {
        if (this.openingHeard || this.closed) return;
        this.log('opening_mark_missing', {});
        this.played('opening');
      }));
      return;
    }
    if (m.serverContent?.turnComplete) {
      this.callerPeak = 0;
      this.heardChars = 0;
      this.checkTimes();
      if (this.turnText.trim()) {
        this.lastTurns.push(this.turnText); if (this.lastTurns.length > 6) this.lastTurns.shift();
        if (this.listingPending) { this.listText = this.turnText; this.listingPending = false; }
        // a read-back stays done: the move test read it back, then a re-ask («جابجا بشه؟») was the last turn and
        // the move was held again
        for (const iso of this.slotWords.keys()) if (this.readBackIn(iso, this.turnText)) this.readBackFor.add(Date.parse(iso));
        // the AI said goodbye after the call's work was done but did not call end_call: hang up once it is played
        // (it said «خدانگهدار», then a re-ask asked «کار دیگه‌ای دارید؟» again)
        if (this.outcome && !this.hangUpWhenSaid && GOODBYE.test(this.turnText) && !/[?؟]/.test(this.turnText)) {
          this.log('goodbye_heard', {});
          this.endedReason = 'assistant-ended-call';
          this.hangUpWhenSaid = true;
          this.timers.push(this.deps.setTimer(GOODBYE_MAX_MS, () => void this.hangUp()));
        }
      }
      this.turnText = '';
      this.claimText = '';
      this.turnTool = false;
      this.muteRestOfTurn = false;
      this.claimTurnOver();
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
      this.playingUntil = this.deps.now().getTime(); // Twilio dropped what it still had: nothing plays now
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
    // every function call Gemini asks for, by name only (never the arguments: they hold the caller's data), so a
    // call that offered times without check_availability shows in the logs
    this.log('tool_call', { tools: calls.map((c) => String(c.name).slice(0, 40)) });
    for (const c of calls) this.line('tool', `${String(c.name).slice(0, 40)} ${JSON.stringify(c.args ?? {}).slice(0, 500)}`);
    this.turnTool = true;
    if (!this.openingSpoken) {
      // e.g. previous_visit_reminder before a word was said: the caller would wait in silence and miss the disclosure
      this.log('tool_before_opening', { tools: calls.map((c) => c.name) });
      const response = { ok: false, reason: 'say_opening_first', hint: `First say the opening, word for word: "${this.opening}"` };
      this.gemini?.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response })) } }));
      return;
    }
    // a booking with no read-back before it is not sent: the AI reads back first (once a call)
    const held = new Set<string>();
    const notOffered = new Set<string>(); // held because check_availability never gave that time
    const noWait = new Set<string>(); // read back in the same turn as the tool call: it did not wait for a yes
    const moveNotBook = new Set<string>(); // a new booking while the caller's appointments are on the table
    // an appointment id the AI made up (not one find_my_appointments gave): it is told the real ones, never sent
    const badId = new Map<string, unknown>();
    for (const c of calls) {
      if (c.name !== 'cancel_appointment' && c.name !== 'reschedule_appointment') continue;
      const args = (c.args ?? {}) as any;
      const id = args.appointment_id;
      // the short name back to the real id; with only one appointment found, any other id means that one
      if (this.apptAlias.has(id)) args.appointment_id = this.apptAlias.get(id);
      else if (this.apptAlias.size === 1) { args.appointment_id = [...this.apptAlias.values()][0]; this.log('appointment_id_guessed', {}); }
      c.args = args;
      if (this.apptAlias.size && ![...this.apptAlias.values()].includes(args.appointment_id) && this.badIdTold < 2) {
        this.badIdTold += 1;
        this.log('appointment_id_unknown', {});
        badId.set(c.id, { ok: false, reason: 'unknown_appointment_id',
          hint: `Use an appointment_id exactly as find_my_appointments gave it: ${[...this.apptIds].map(([i, t]) => `${i} (${t})`).join(', ')}.` });
      }
    }
    for (const c of calls) {
      const args = c.args as any;
      if (badId.has(c.id)) { held.add(c.id); continue; }
      if (c.name === 'cancel_appointment' && this.cancelRefused < 1 && !this.cancelConfirmed()) {
        held.add(c.id);
        this.cancelRefused += 1;
        this.log('cancel_confirm_missing', {});
        continue;
      }
      const start = c.name === 'book_appointment' ? args?.start_iso : c.name === 'reschedule_appointment' ? args?.new_start_iso : undefined;
      if (start === undefined) continue;
      // the caller asked about their appointments and the AI books a new one: a move done as a booking leaves the
      // old appointment too (the move test booked Sunday 9 AM and kept Friday 6:30 PM)
      if (c.name === 'book_appointment' && this.apptAlias.size && this.bookAfterListRefused < 1) {
        held.add(c.id);
        moveNotBook.add(c.id);
        this.bookAfterListRefused += 1;
        this.log('book_after_appointments', {});
        continue;
      }
      if (this.notOfferedRefused < 1 && !this.offered(start)) {
        held.add(c.id);
        notOffered.add(c.id);
        this.notOfferedRefused += 1;
        this.log('time_not_offered', {});
        continue;
      }
      if (this.readBackRefused >= 1 || this.readBackDone(start)) continue;
      held.add(c.id);
      this.readBackRefused += 1;
      // the read-back is in this very turn: the AI did not wait for the answer (the move test: «…درسته؟» and the tool)
      if (typeof start === 'string' && /[?؟]/.test(this.turnText) && this.readBackIn(start, this.turnText)) noWait.add(c.id);
      this.log('read_back_missing', noWait.has(c.id) ? { same_turn: true } : {});
    }
    for (const c of calls) this.fixIds(c);
    const forCore = calls.filter((c) => CORE_TOOL_NAMES.has(c.name) && !held.has(c.id));
    let results: { toolCallId: string; result: string }[] = [];
    if (forCore.length) {
      try {
        const t = this.deps.now().getTime();
        results = await this.deps.core.tools(this.ids, forCore.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
        // how long barber-core took (a long pause in a call is either this or gemini_reply)
        this.log('tool_timing', { tools: forCore.map((c) => c.name), ms: this.deps.now().getTime() - t });
      } catch (e: any) {
        this.log('core_tools_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
      }
    }
    for (const c of calls) {
      if (badId.has(c.id)) {
        this.line('tool', `${c.name} → held: unknown appointment id`);
        responses.push({ id: c.id, name: c.name, response: badId.get(c.id) });
        continue;
      }
      if (held.has(c.id)) {
        const cancel = c.name === 'cancel_appointment';
        const why = moveNotBook.has(c.id) ? 'move, not a new booking?' : notOffered.has(c.id) ? 'time not offered' : cancel ? 'confirm first' : 'read back first';
        this.line('tool', `${c.name} → held: ${why}`);
        responses.push({ id: c.id, name: c.name, response: moveNotBook.has(c.id)
          ? { ok: false, reason: 'move_not_book', hint: this.moveNotBookHint() }
          : notOffered.has(c.id)
          ? { ok: false, reason: 'time_not_offered', hint: NOT_OFFERED }
          : cancel
          ? { ok: false, reason: 'confirm_first', hint: CONFIRM_CANCEL }
          : { ok: false, reason: 'read_back_first', hint: noWait.has(c.id) ? READ_BACK_WAIT : READ_BACK_FIRST } });
        continue;
      }
      if (c.name === 'end_call' && !this.hangUpWhenSaid && !this.nudged && this.askedAt > this.callerAt && this.endRefusedForQuestion < 2) {
        this.endRefusedForQuestion += 1;
        this.log('end_call_refused', { why: 'question_unanswered' });
        responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'caller_not_answered', hint: WAIT_FOR_ANSWER } });
        continue;
      }
      if (c.name === 'end_call') {
        // the call is not finished yet (nothing booked, no message, no transfer): ask the AI to continue, once
        // (never after the silence goodbye: that one ends the call on purpose)
        if (!this.outcome && !this.refusedEnd && !this.hangUpWhenSaid) {
          this.refusedEnd = true;
          this.log('end_call_refused', {});
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
      if (!CORE_TOOL_NAMES.has(c.name)) {
        this.log('tool_unknown', { tool: String(c.name).slice(0, 40) });
        responses.push({ id: c.id, name: c.name, response: { ok: false, reason: 'unknown_tool' } });
        continue;
      }
      const raw = results.find((x) => x.toolCallId === c.id)?.result;
      if (raw) this.learnIds(raw);
      this.line('tool', `${c.name} → ${String(raw ?? 'no answer').slice(0, 500)}`);
      let result: any = { ok: false, reason: 'system_error' };
      try { if (raw) result = JSON.parse(raw); } catch { /* keep system_error */ }
      // the reason code only (e.g. slot_taken), never the arguments or the caller's data
      this.log('tool_result', { tool: c.name, ok: result?.ok === true, ...(result?.ok === true ? {} : { reason: String(result?.reason ?? '').slice(0, 40) }) });
      if (result?.ok === true && ['check_availability', 'find_my_appointments'].includes(c.name)) this.timesChecked = true;
      // every time it gave: that day's, the next free day's and other staff members' (the move test offered only the
      // next day's times, so none were remembered and its booking went through with no read-back)
      if (c.name === 'check_availability' && result?.ok === true) {
        this.rememberSlots([...(Array.isArray(result.slots) ? result.slots : []),
          ...(Array.isArray(result.next_day_with_openings?.slots) ? result.next_day_with_openings.slots : []),
          ...(Array.isArray(result.other_barbers) ? result.other_barbers.flatMap((b: any) => (Array.isArray(b?.slots) ? b.slots : [])) : [])]);
      }
      if (c.name === 'find_my_appointments' && result?.ok === true && Array.isArray(result.appointments)) {
        this.apptCount = result.appointments.length;
        this.listingPending = true;
        // Gemini gets short names (appt-1, appt-2): it made up long ids instead of copying them
        result = { ...result, appointments: result.appointments.map((a: any) => {
          if (typeof a?.appointment_id !== 'string') return a;
          let alias = [...this.apptAlias].find(([, real]) => real === a.appointment_id)?.[0];
          if (!alias) { alias = `appt-${this.apptAlias.size + 1}`; this.apptAlias.set(alias, a.appointment_id); }
          this.apptIds.set(alias, `${a.local_date ?? ''} ${a.local_time ?? ''}`.trim());
          return { ...a, appointment_id: alias };
        }) };
      }
      if (result?.ok === true && ['book_appointment', 'take_message', 'transfer_to_human', 'cancel_appointment', 'reschedule_appointment'].includes(c.name)) this.outcome = true;
      // the call's language is fixed: Gemini listens for it and answers only in it from now on
      if (c.name === 'set_caller_language' && result?.ok === true && typeof result.language === 'string') {
        result = { ...result, next: this.languageNote(result.language) };
        // the AI already asked its question in this turn and set the language after it: what it says next in
        // this turn is that question again («…کدوم رو می‌خواید؟…کدوم رو می‌خواید؟»), so the caller does not hear it
        if (this.turnAudio && /[?؟]/.test(this.turnText) && calls.every((x) => x.name === 'set_caller_language')) {
          this.muteRestOfTurn = true;
          this.log('repeat_muted', {});
        }
      }
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
    if (!r.ok) this.log('twilio_update_failed', { call: this.ids.callSid, error: r.error ?? '' });
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
    this.log('call_ended', { reason: this.endedReason });
    for (const t of this.timers) this.deps.clearTimer(t);
    this.gemini?.close();
    if (!this.ids.callSid) return;
    try {
      await this.deps.core.end(this.ids, { startedAt: this.started, endedAt: this.deps.now().toISOString(), endedReason: this.endedReason,
        transcript: this.transcript.map((l) => ({ ...l, body: l.body.trim() })).filter((l) => l.body) });
    } catch (e: any) {
      this.log('core_end_failed', { call: this.ids.callSid, error: String(e?.message ?? e) });
    }
  }
}

/** The loudest sample of 16-bit PCM audio (0 for silence). */
function peakOf(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak;
}
