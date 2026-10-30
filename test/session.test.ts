// A whole call with fake sockets: barber-core's opening, the setup sent to Gemini, audio both ways,
// a tool call through barber-core, a transfer to the salon, and the end-of-call report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallSession, type SessionDeps } from '../src/session.ts';
import { pcm16ToMulaw } from '../src/audio.ts';

function harness(startAnswer: any, toolAnswer: (list: any[]) => any[] = () => [], clock = { t: Date.parse('2026-10-22T15:00:00Z') }, speak?: (text: string) => Promise<string | null>) {
  const sentToGemini: any[] = [];
  const sentToTwilio: any[] = [];
  const core: any[] = [];
  const updates: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const logs: [string, any][] = [];
  let gem: any;
  const sockets: any[] = [];
  const deps: SessionDeps = {
    core: {
      start: async (c: any, voice?: string) => { core.push(['start', c]); if (voice) core.push(['voice', voice]); return startAnswer; },
      saveOpening: async (c: any, x: any) => { core.push(['saveOpening', x]); return { ok: true }; },
      tools: async (c: any, list: any[]) => { core.push(['tools', list]); return toolAnswer(list); },
      end: async (c: any, x: any) => { core.push(['end', x]); return {}; },
    } as any,
    openGemini: (h) => { gem = h; sockets.push(h); return { send: (d) => sentToGemini.push(JSON.parse(d)), close: () => {} }; },
    updateCall: async (_sid, twiml) => { updates.push(twiml); return { ok: true }; },
    prompt: 'You answer for {{shop_name}}.', model: 'live-model', voice: 'Kore',
    setTimer: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clearTimer: () => {},
    now: () => new Date(clock.t), log: (event, data) => logs.push([event, data]),
    ...(speak ? { speak } : {}),
  };
  const s = new CallSession(deps, { send: (d) => sentToTwilio.push(JSON.parse(d)), close: () => {} });
  return { s, sentToGemini, sentToTwilio, core, updates, timers, logs, sockets, gem: () => gem };
}
// the opening is said (audio) and Twilio confirms it was played: from now on the caller is heard
// the AI has started the opening (audio): tools may run
async function speak(h: ReturnType<typeof harness>) {
  await h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } } }));
}
// the caller spoke once and the AI answered them: a conversation has started (re-asks: up to 2)
async function talked(h: ReturnType<typeof harness>) {
  await speak(h);
  await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
}
async function heard(h: ReturnType<typeof harness>) {
  await h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } } }));
  await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
  h.s.played('opening');
}
const ids = { callSid: 'CA' + '1'.repeat(32), to: '+14013295007', from: '+12013702511' };
const OPEN = { assistantId: 'x', assistantOverrides: { firstMessage: 'با Test Salon تماس گرفته‌اید. من دستیار هوش مصنوعی هستم و این تماس ممکن است ضبط شود.', maxDurationSeconds: 120, variableValues: { shop_name: 'Test Salon' } } };

describe('a call', () => {
  it('opens Gemini with the salon prompt, voice and tools; says the opening first; carries audio both ways', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    assert.deepEqual(h.core[0], ['start', { callId: ids.callSid, callSid: ids.callSid, to: ids.to, from: ids.from }]);
    h.gem().onOpen();
    const setup = h.sentToGemini[0].setup;
    assert.equal(setup.model, 'models/live-model');
    assert.equal(setup.systemInstruction.parts[0].text, 'You answer for Test Salon.');
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.ok(setup.tools[0].functionDeclarations.some((d: any) => d.name === 'book_appointment'));
    assert.equal(h.timers[0].ms, 120_000); // the salon's call limit
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.length, 1, 'no audio before Gemini is ready');
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    assert.match(h.sentToGemini[1].clientContent.turns[0].parts[0].text, /این تماس ممکن است ضبط شود/);
    h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } } }));
    assert.equal(h.sentToTwilio[0].event, 'media');
    assert.equal(Buffer.from(h.sentToTwilio[0].media.payload, 'base64').length, 80);
    // while the opening plays, the caller's "hello?" is not passed on and cannot cut it off
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160, 0x7f)).toString('base64'));
    h.gem().onMessage(JSON.stringify({ serverContent: { interrupted: true } }));
    assert.equal(h.sentToGemini.length, 2, 'no caller audio during the opening');
    assert.equal(h.sentToTwilio.length, 1, 'the opening is not cleared');
    h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.deepEqual(h.sentToTwilio[1], { event: 'mark', streamSid: 'MZ1', mark: { name: 'opening' } });
    h.s.played('opening'); // Twilio: played in full
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini[2].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    h.gem().onMessage(JSON.stringify({ serverContent: { interrupted: true } }));
    assert.equal(h.sentToTwilio.at(-1).event, 'clear');
  });

  it('an opening turn with no audio is asked again; if Twilio never confirms it, the caller is heard after 20 s', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } })); // nothing was said
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, 2, 'the opening asked again');
    assert.deepEqual(h.logs.find(([e]) => e === 'opening_again'), ['opening_again', { tries: 2 }]);
    await heard({ ...h, s: { played: () => {} } as any }); // said, but no mark comes back
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.filter((m) => m.realtimeInput).length, 0);
    h.timers.find((t) => t.ms === 20_000)!.fn();
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.filter((m) => m.realtimeInput).length, 1);
    assert.ok(h.logs.some(([e]) => e === 'opening_mark_missing'));
  });

  it('tools go to barber-core and their results back to Gemini; a yes from transfer_to_human moves the call', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: t.name === 'transfer_to_human' ? '{"ok":true,"transfer_to":"+14015550100"}' : '{"ok":true,"slots":[]}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'check_availability', args: { date: '2026-10-23' } }, { id: 'f2', name: 'nope' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.core[1], ['tools', [{ id: 'f1', name: 'check_availability', args: { date: '2026-10-23' } }]]);
    const resp = h.sentToGemini.at(-1).toolResponse.functionResponses;
    assert.deepEqual(resp, [{ id: 'f1', name: 'check_availability', response: { ok: true, slots: [] } }, { id: 'f2', name: 'nope', response: { ok: false, reason: 'unknown_tool' } }]);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f3', name: 'transfer_to_human', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    const t = h.timers.at(-1)!;
    assert.equal(t.ms, 4000);
    t.fn();
    await new Promise((r) => setImmediate(r));
    assert.match(h.updates[0], /<Number>\+14015550100<\/Number>/);
    assert.match(h.updates[0], /callerId="\+12013702511"/);
    const { transcript, ...end } = h.core.at(-1)[1];
    assert.equal(h.core.at(-1)[0], 'end');
    assert.deepEqual(end, { startedAt: '2026-10-22T15:00:00.000Z', endedAt: '2026-10-22T15:00:00.000Z', endedReason: 'assistant-forwarded-call' });
    assert.ok(transcript.some((l: any) => l.speaker === 'tool' && l.body.startsWith('check_availability → {"ok":true')), 'tool results are in the call\'s text');
  });

  it('barber-core says the number cannot take calls: a short notice and hang up, no Gemini', async () => {
    const h = harness({ error: 'Sorry, this number cannot take calls right now.' });
    await h.s.start('MZ1', ids);
    assert.equal(h.gem(), undefined);
    assert.match(h.updates[0], /<Say>Sorry, this number cannot take calls right now.<\/Say><Hangup\/>/);
    assert.equal(h.core.at(-1)[0], 'end');
  });

  it('the AI is turned off for the salon: the call goes straight to its transfer number', async () => {
    const h = harness({ destination: { type: 'number', number: '+14015550100' } });
    await h.s.start('MZ1', ids);
    assert.match(h.updates[0], /<Number>\+14015550100<\/Number>/);
  });

  it('a failed tool call is a system_error for the AI (it then offers a person or a message), and end_call hangs up once', async () => {
    const h = harness(OPEN, () => { throw new Error('down'); });
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'book_appointment', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response, { ok: false, reason: 'system_error' });
    // a failed booking is not an outcome: the first end_call is refused once, then accepted
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f2', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f3', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    h.timers.at(-1)!.fn();
    await new Promise((r) => setImmediate(r));
    await h.s.finish();
    assert.equal(h.core.filter((c) => c[0] === 'end').length, 1);
    assert.equal(h.core.at(-1)[1].endedReason, 'assistant-ended-call');
  });

  it('logs what Gemini says that ends a call (goAway) and each tool result (name and ok only, never the arguments)', async () => {
    const h = harness(OPEN, () => [{ toolCallId: 'f1', name: 'check_availability', result: '{"ok":true,"slots":["10:00"]}' }]);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ goAway: { timeLeft: '30s' } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'check_availability', args: { date: '2026-10-23', name: 'Dana' } }] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.logs.find(([e]) => e === 'gemini_go_away'), ['gemini_go_away', { timeLeft: '30s' }]);
    assert.deepEqual(h.logs.find(([e]) => e === 'tool_result'), ['tool_result', { tool: 'check_availability', ok: true }]);
    assert.doesNotMatch(JSON.stringify(h.logs), /Dana|2026-10-23/);
  });

  it('the setup: a short pause, but no interruption by line noise or the AI\'s own voice', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    const setup = h.sentToGemini[0].setup;
    assert.equal(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 600);
    // a long call is not cut at the 15-minute audio limit: the older part of the conversation is compressed
    assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
    // the caller's speech on a phone line is quiet: the model must hear it (default sensitivity, not LOW)
    assert.equal(setup.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity, undefined);
  });

  it('our own turns (GEMINI_TURNS=ours): Gemini\'s detection is off; a clear voice starts a turn with the 200 ms before it, 700 ms of quiet ends it', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    (h.s as any).deps.ourTurns = true;
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    assert.deepEqual(h.sentToGemini[0].setup.realtimeInputConfig.automaticActivityDetection, { disabled: true });
    assert.ok(h.logs.some(([e, d]) => e === 'gemini_setup' && d.turns === 'ours'));
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h); // "Which day?"
    clock.t += 3000; // the AI's words are played
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    const from = h.sentToGemini.length;
    const kinds = () => h.sentToGemini.slice(from).map((m) => m.realtimeInput ? Object.keys(m.realtimeInput)[0] : Object.keys(m)[0]);
    for (let i = 0; i < 12; i++) { clock.t += 20; h.s.fromCaller(silent); }
    assert.deepEqual(kinds(), [], 'nothing before the caller speaks');
    for (let i = 0; i < 15; i++) { clock.t += 20; h.s.fromCaller(loud); } // «فردا», 300 ms
    assert.equal(kinds()[0], 'activityStart');
    assert.equal(kinds().filter((k) => k === 'audio').length, 10 + 14, 'the 200 ms before the voice, then the voice');
    for (let i = 0; i < 30; i++) { clock.t += 20; h.s.fromCaller(silent); }
    assert.equal(kinds().filter((k) => k === 'activityEnd').length, 0, 'not yet: 600 ms of quiet');
    for (let i = 0; i < 10; i++) { clock.t += 20; h.s.fromCaller(silent); }
    assert.deepEqual(kinds().filter((k) => k !== 'audio'), ['activityStart', 'activityEnd'], 'one short answer, one turn');
    const n = kinds().length;
    for (let i = 0; i < 20; i++) { clock.t += 20; h.s.fromCaller(silent); }
    assert.equal(kinds().length, n, 'no audio between turns');
  });

  it('our own turns: no re-ask while Gemini is still answering the caller\'s turn (up to 15 s); after that the count starts again', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    (h.s as any).deps.ourTurns = true;
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    clock.t += 3000;
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    for (let i = 0; i < 15; i++) { clock.t += 20; h.s.fromCaller(loud); } // «نوبت»
    for (let i = 0; i < 40; i++) { clock.t += 20; h.s.fromCaller(silent); } // the turn ends
    assert.ok(h.sentToGemini.some((m) => m.realtimeInput?.activityEnd));
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: ' نوبت' } } })); // Gemini heard it
    for (let i = 0; i < 13; i++) { clock.t += 1000; h.s.fromCaller(silent); } // Gemini thinks for 13 s
    assert.ok(!h.logs.some(([e]) => e === 'wait_restarted' || e === 'reask'), 'Gemini is still answering: no re-ask over it');
    for (let i = 0; i < 20; i++) { clock.t += 1000; h.s.fromCaller(silent); } // it never answers
    assert.ok(h.logs.some(([e]) => e === 'wait_restarted'), 'the line is never silent for good');
  });

  it('our own turns: a turn Gemini wrote nothing of is not waited on: the count starts as usual', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    (h.s as any).deps.ourTurns = true;
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    clock.t += 3000;
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    for (let i = 0; i < 15; i++) { clock.t += 20; h.s.fromCaller(loud); } // «دوشنبه», not heard by Gemini
    for (let i = 0; i < 40; i++) { clock.t += 20; h.s.fromCaller(silent); }
    for (let i = 0; i < 13; i++) { clock.t += 1000; h.s.fromCaller(silent); }
    assert.ok(h.logs.some(([e]) => e === 'wait_restarted'), 'not left in silence for 22 s');
  });

  it('our own turns: while the AI\'s words still play at the caller only a louder voice starts one (its echo does not cut it off); then a normal one does', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    (h.s as any).deps.ourTurns = true;
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    // 2 s of the AI's words (24 kHz PCM), sent to Twilio at once: they play for 2 s
    await h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(96_000).toString('base64') } }] } } }));
    const echo = Buffer.alloc(160, 0xbc).toString('base64'); // ~2360: above the hiss, below the louder mark
    const starts = () => h.sentToGemini.filter((m) => m.realtimeInput?.activityStart).length;
    for (let i = 0; i < 20; i++) { clock.t += 20; h.s.fromCaller(echo); }
    assert.equal(starts(), 0, 'its own words, while they play');
    clock.t += 1700; // played: the AI's turn may still go on (a tool), but nothing plays
    h.s.fromCaller(echo);
    assert.equal(starts(), 1, 'a normal voice right after the question starts a turn');
  });

  it('the start-of-speech settings from the host reach Gemini, and the call\'s text says which were used', async () => {
    const h = harness(OPEN);
    (h.s as any).deps.activity = { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', prefixPaddingMs: 20 };
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    assert.deepEqual(h.sentToGemini[0].setup.realtimeInputConfig.automaticActivityDetection,
      { silenceDurationMs: 600, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', prefixPaddingMs: 20 });
    assert.ok(h.logs.some(([e, d]) => e === 'gemini_setup' && d.startOfSpeechSensitivity === 'START_SENSITIVITY_HIGH'));
  });

  it('a caller who never spoke: the re-ask and the goodbye are asked in the salon\'s language (not English in a Persian call)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const fa = { ...OPEN, assistantOverrides: { ...OPEN.assistantOverrides, variableValues: { shop_name: 'Test Salon', default_language: 'fa-IR' } } };
    const h = harness(fa, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).map((m) => m.clientContent.turns[0].parts[0].text);
    clock.t += 8000; h.s.fromCaller(silent);
    assert.match(said().at(-1), /in Persian \(Farsi\) \(after the opening: just "How can I help you\?", said in Persian \(Farsi\)\)/);
    await speak(h); await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 9000; h.s.fromCaller(silent);
    assert.match(said().at(-1), /Say it in Persian \(Farsi\)\.$/);
  });

  it('no answer to the question and both re-asks: 15 s later the AI thanks the caller and ends (once)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64'); // mu-law silence
    const said = () => h.sentToGemini.filter((m) => m.clientContent).map((m) => m.clientContent.turns[0].parts[0].text);
    const aiSays = async () => {
      await speak(h);
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    clock.t += 8000; h.s.fromCaller(silent); // re-ask 1
    await aiSays();
    clock.t += 8000; h.s.fromCaller(silent); // re-ask 2
    await aiSays();
    clock.t += 14000; h.s.fromCaller(silent);
    assert.equal(said().length, 3, 'no goodbye yet');
    clock.t += 2000; h.s.fromCaller(silent);
    clock.t += 20000; h.s.fromCaller(silent);
    assert.equal(said().length, 4, 'the opening, 2 re-asks, one goodbye');
    assert.match(said()[3], /not answered at all.*call again.*end_call/s);
    assert.deepEqual(h.logs.find(([e]) => e === 'silence_nudge'), ['silence_nudge', { silentSeconds: 16, callerPeak: 0, heardChars: 0 }], 'how loud the line was, and how much Gemini wrote down (a count, never the words)');
    // the AI's end_call after the silence goodbye is accepted (nothing booked, but the caller said nothing)
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e9', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.ok, true, 'no "not finished" refusal');
    assert.ok(!h.logs.some(([e]) => e === 'end_call_refused'));
    // the goodbye ends the call at once, even if the AI never calls end_call
    await aiSays();
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'goodbye' } });
    assert.equal(h.updates.length, 0);
    h.s.played('goodbye');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1, 'hung up as soon as the goodbye was played');
  });

  it('the caller never spoke: after the opening\'s "How can I help you?" only one re-ask, then the goodbye 8 s later', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).map((m) => m.clientContent.turns[0].parts[0].text);
    clock.t += 6000; h.s.fromCaller(silent);
    assert.match(said()[1], /last question again/, 'one re-ask');
    await speak(h); await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 6000; h.s.fromCaller(silent);
    assert.equal(said().length, 2, 'no second re-ask');
    clock.t += 3000; h.s.fromCaller(silent);
    assert.match(said()[2], /not answered at all.*end_call/s, 'the goodbye');
  });

  it('a quiet caller the AI answers, or a long tool run, is never taken for silence (no goodbye mid-booking)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).length;
    clock.t += 8000; h.s.fromCaller(silent); // re-ask 1 (the caller answered too quietly for the meter)
    await speak(h); await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent); // re-ask 2
    await speak(h); await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    // Gemini heard the quiet "morning" and answers on its own: the re-asks start again
    clock.t += 3000; await speak(h);
    let release: () => void = () => {};
    (h as any).s.deps.core.tools = () => new Promise((r) => { release = () => r([]); });
    const running = h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 't1', name: 'check_availability', args: {} }] } }));
    clock.t += 40000; h.s.fromCaller(silent);
    assert.equal(said(), 3, 'no goodbye and no re-ask while the tool runs');
    release(); await running;
    assert.ok(!h.logs.some(([e]) => e === 'silence_nudge'));
  });

  it('the last visit is looked up by this server right after the opening (the AI is not given the tool); its sentence goes to the AI only when remind is true', async () => {
    for (const [answer, told] of [['{"ok":true,"remind":true,"spoken":"آخرین مراجعهٔ شما ۲۱ روز پیش بود."}', true], ['{"ok":true,"remind":false}', false]] as const) {
      const asked: any[] = [];
      const h = harness(OPEN, (list) => { asked.push(...list); return list.map((t) => ({ toolCallId: t.id, name: t.name, result: answer })); });
      await h.s.start('MZ1', ids);
      h.gem().onOpen();
      assert.ok(!h.sentToGemini[0].setup.tools[0].functionDeclarations.some((d: any) => d.name === 'previous_visit_reminder'), 'not a tool of the AI');
      await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
      await heard(h);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(asked.map((t) => t.name), ['previous_visit_reminder']);
      const notes = h.sentToGemini.filter((m) => m.clientContent?.turns?.[0]?.parts?.[0]?.text?.startsWith('Note from the phone system'));
      assert.equal(notes.length, told ? 1 : 0);
      if (told) assert.match(notes[0].clientContent.turns[0].parts[0].text, /exactly.*"آخرین مراجعهٔ شما ۲۱ روز پیش بود\."/);
    }
  });

  it('the caller\'s words written down late (after the AI already answered) never make the AI answer again', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h); // "Which day?"
    h.s.played();
    const before = h.sentToGemini.filter((m) => m.clientContent).length;
    await speak(h); // the AI already answered "tomorrow" ...
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: ' فردا' } } })); // ... and the words come after
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    for (let i = 0; i < 4; i++) { clock.t += 1500; h.s.fromCaller(silent); }
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, before, 'nothing is sent: the AI would ask its question again');
  });

  it('the call\'s text goes to barber-core at the end: the opening, the AI\'s and the caller\'s words in pieces joined per turn, tools, and the server\'s notes', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true,"slots":[]}' })), clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'با Test Salon ' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'تماس گرفته‌اید.' } } }));
    await heard(h);
    clock.t += 3000;
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: ' یه نوبت' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: ' می‌خواستم' } } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'check_availability', args: { date: '2026-10-23' } }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'Erfan is free at 9.' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    h.s.played();
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    clock.t += 6000; h.s.fromCaller(silent); // a re-ask: the server's note is in the text too
    await h.s.finish();
    const [kind, report] = h.core.at(-1);
    assert.equal(kind, 'end');
    assert.deepEqual(report.transcript.map((l: any) => [l.speaker, l.body, l.at_ms]), [
      ['system', 'gemini_setup {"model":"live-model","plain":false}', 0], // which hearing settings the call used
      ['ai', 'با Test Salon تماس گرفته‌اید.', 0],
      ['tool', 'previous_visit_reminder → {"ok":true,"slots":[]}', 0], // looked up by this server after the opening
      ['caller', 'یه نوبت می‌خواستم', 3000],
      ['tool', 'check_availability {"date":"2026-10-23"}', 3000],
      ['system', 'tool_timing {"tools":["check_availability"],"ms":0}', 3000],
      ['tool', 'check_availability → {"ok":true,"slots":[]}', 3000],
      ['ai', 'Erfan is free at 9.', 3000],
      ['system', 'reask {"n":1,"loudMsAgo":6000,"callerPeak":0,"heardChars":0}', 9000],
      ['system', 'call_ended {"reason":"customer-ended-call"}', 9000],
    ]);
  });

  it('book_appointment only after a read-back with the chosen time and a question; without it the AI is told to read back first (once)', async () => {
    const slots = [{ start_iso: '2026-10-30T13:00:00.000Z', local_time: '09:00', spoken: 'ساعت نه صبح', spoken_en: '9:00 AM' },
      { start_iso: '2026-10-30T18:00:00.000Z', local_time: '14:00', spoken: 'ساعت دو بعد از ظهر', spoken_en: '2:00 PM' }];
    const sentToCore: string[] = [];
    const h = harness(OPEN, (list) => list.map((t) => {
      sentToCore.push(t.name);
      return { toolCallId: t.id, name: t.name, result: JSON.stringify(t.name === 'check_availability' ? { ok: true, slots } : { ok: true }) };
    }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    await tool('c1', 'check_availability');
    await turn('عرفان جمعه ساعت نه صبح یا ساعت دو بعد از ظهر وقت داره. کدوم مناسب‌تره؟');
    assert.equal((await tool('b0', 'book_appointment', { start_iso: slots[0].start_iso })).reason, 'read_back_first', 'the offer (several times and a question) is not a read-back');
    (h.s as any).readBackRefused = 0;
    await turn('یادآوری واتساپ براتون بفرستیم؟');
    const held = await tool('b1', 'book_appointment', { start_iso: slots[0].start_iso });
    assert.equal(held.reason, 'read_back_first');
    assert.deepEqual(sentToCore.filter((n) => n !== 'previous_visit_reminder'), ['check_availability'], 'not sent to barber-core');
    assert.ok(h.logs.some(([e]) => e === 'read_back_missing'));
    (h.s as any).readBackRefused = 0;
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'جمعه سی‌ام اکتبر ساعت نه صبح انجام شد. درسته؟' } } }));
    const rushed = await tool('b1b', 'book_appointment', { start_iso: slots[0].start_iso });
    assert.equal(rushed.reason, 'read_back_first');
    assert.match(rushed.hint, /did not|same breath/, 'read back and the tool in one turn: told to wait for the answer');
    await h.gem().onMessage(JSON.stringify({ serverContent: { interrupted: true } })); // the caller answers: the rushed turn is over
    await turn('اصلاح مو با عرفان، جمعه سی‌ام اکتبر ساعت نه صبح، به نام علیرضا نعمتی. درسته؟');
    await turn('درسته؟'); // a re-ask after the read-back: the read-back still counts
    assert.equal((await tool('b2', 'book_appointment', { start_iso: slots[0].start_iso })).ok, true);
    assert.deepEqual(sentToCore.filter((n) => n !== 'previous_visit_reminder'), ['check_availability', 'book_appointment']);
  });

  it('a move to a time check_availability never gave is held once; the next free day\'s times count as offered and need a read-back', async () => {
    const next = [{ start_iso: '2026-10-30T13:00:00.000Z', local_time: '09:00', spoken: 'ساعت نه صبح' },
      { start_iso: '2026-10-30T22:00:00.000Z', local_time: '18:00', spoken: 'ساعت شش عصر' }];
    const sent: string[] = [];
    const h = harness(OPEN, (list) => list.map((t) => {
      sent.push(t.name);
      const result = t.name === 'check_availability' ? { ok: true, slots: [], next_day_with_openings: { date: '2026-10-30', slots: next } }
        : t.name === 'find_my_appointments' ? { ok: true, appointments: [{ appointment_id: 'a1', local_time: '18:30' }] } : { ok: true };
      return { toolCallId: t.id, name: t.name, result: JSON.stringify(result) };
    }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    await tool('f1', 'find_my_appointments');
    await tool('c1', 'check_availability');
    await turn('جمعه ساعت نه صبح یا ساعت شش عصر وقت داره. کدوم؟');
    const own = await tool('r1', 'reschedule_appointment', { appointment_id: 'appt-1', new_start_iso: '2026-10-30T22:30:00Z' });
    assert.equal(own.reason, 'time_not_offered', '6:30 was never offered (it is the appointment\'s own time)');
    assert.ok(h.logs.some(([e]) => e === 'time_not_offered'));
    assert.equal((await tool('r2', 'reschedule_appointment', { appointment_id: 'appt-1', new_start_iso: '2026-10-30T22:00:00Z' })).reason, 'read_back_first',
      'a next-day time is remembered: the offer is not its read-back, however the time is written');
    await turn('نوبتتون رو به جمعه سی‌ام اکتبر ساعت شش عصر با عرفان می‌برم. درسته؟');
    assert.equal((await tool('r3', 'reschedule_appointment', { appointment_id: 'appt-1', new_start_iso: '2026-10-30T22:00:00.000Z' })).ok, true);
    assert.deepEqual(sent.filter((n) => n !== 'previous_visit_reminder'), ['find_my_appointments', 'check_availability', 'reschedule_appointment']);
  });

  it('a booking after the caller\'s appointments were found is held once: a move is reschedule_appointment', async () => {
    const slots = [{ start_iso: '2026-11-01T14:00:00.000Z', local_time: '09:00', spoken: 'ساعت نه صبح' }];
    const sent: string[] = [];
    const h = harness(OPEN, (list) => list.map((t) => {
      sent.push(t.name);
      const result = t.name === 'check_availability' ? { ok: true, slots }
        : t.name === 'find_my_appointments' ? { ok: true, appointments: [{ appointment_id: 'a1', local_date: '2026-10-30', local_time: '18:30' }] } : { ok: true };
      return { toolCallId: t.id, name: t.name, result: JSON.stringify(result) };
    }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    await tool('f1', 'find_my_appointments');
    await tool('c1', 'check_availability');
    await turn('اصلاح مو با عرفان، یکشنبه یکم نوامبر ساعت نه صبح. درسته؟');
    const held = await tool('b1', 'book_appointment', { start_iso: slots[0].start_iso });
    assert.equal(held.reason, 'move_not_book');
    assert.ok(held.hint.includes('appt-1 (2026-10-30 18:30)') && held.hint.includes('reschedule_appointment'));
    assert.ok(h.logs.some(([e]) => e === 'book_after_appointments'));
    assert.equal((await tool('r1', 'reschedule_appointment', { appointment_id: 'appt-1', new_start_iso: slots[0].start_iso })).ok, true);
    assert.deepEqual(sent.filter((n) => n !== 'previous_visit_reminder'), ['find_my_appointments', 'check_availability', 'reschedule_appointment'], 'the booking never reached barber-core');
  });

  it('a staff or service id one or two characters off one the call was given is corrected; a far one is left for barber-core', async () => {
    const CUT = '10b40df1-a1ac-4cf0-a248-403421526739', ERFAN = '43cb848e-e7c6-4899-89f9-ecde11c08d7f';
    const sentArgs: any[] = [];
    const h = harness(OPEN, (list) => list.map((t) => {
      sentArgs.push(t.args);
      return { toolCallId: t.id, name: t.name, result: JSON.stringify(t.name === 'find_services' ? { ok: true, services: [{ service_id: CUT, staff: [ERFAN] }] } : { ok: true, slots: [] }) };
    }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
    };
    await tool('f1', 'find_services', { query: 'haircut' });
    await tool('c1', 'check_availability', { staff_id: ERFAN.replace('43cb', '43cc'), service_ids: ['10b40df0-a1ac-4cf0-a248-403421526739'], date: '2026-10-31' });
    assert.deepEqual([sentArgs.at(-1).staff_id, sentArgs.at(-1).service_ids], [ERFAN, [CUT]], 'one character off: the real ids');
    assert.ok(h.logs.some(([e]) => e === 'id_corrected'));
    await tool('c2', 'check_availability', { staff_id: ERFAN, service_ids: ['00000000-0000-4000-8000-000000000021'], date: '2026-10-31' });
    assert.deepEqual(sentArgs.at(-1).service_ids, ['00000000-0000-4000-8000-000000000021'], 'far from every known id: sent as it is (barber-core says unknown_service)');
  });

  it('«ساعت نه و نیم صبح؟» alone is not the read-back (it names no day); a move before find_my_appointments is told to find first', async () => {
    const slots = [{ start_iso: '2026-11-02T14:30:00.000Z', local_time: '09:30', spoken: 'ساعت نه و نیم صبح' },
      { start_iso: '2026-11-02T19:00:00.000Z', local_time: '14:00', spoken: 'ساعت دو بعد از ظهر' }];
    const sent: string[] = [];
    const h = harness(OPEN, (list) => list.map((t) => {
      sent.push(t.name);
      const result = t.name === 'check_availability' ? { ok: true, day_spoken: 'دوشنبه دوم نوامبر', slots }
        : t.name === 'find_my_appointments' ? { ok: true, appointments: [{ appointment_id: 'a1', local_date: '2026-11-02', local_time: '09:30' }] } : { ok: true };
      return { toolCallId: t.id, name: t.name, result: JSON.stringify(result) };
    }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    await tool('c1', 'check_availability');
    await turn('ساعت نه و نیم صبح؟');
    assert.equal((await tool('b1', 'book_appointment', { start_iso: slots[0].start_iso })).reason, 'read_back_first', 'a question about the time, not the read-back');
    await turn('اصلاح مو با عرفان، دوشنبه دوم نوامبر ساعت نه و نیم صبح، درسته؟');
    assert.equal((await tool('b2', 'book_appointment', { start_iso: slots[0].start_iso })).ok, true);
    const made = await tool('r1', 'reschedule_appointment', { appointment_id: 'd5f7b8c2-2c67-4e6c-a634-862ae51a141c', new_start_iso: slots[1].start_iso });
    assert.equal(made.reason, 'find_first', 'no appointment was found in this call: the id is made up');
    assert.ok(!sent.includes('reschedule_appointment'));
    await tool('f1', 'find_my_appointments');
    await turn('نوبتتون رو به دوشنبه دوم نوامبر ساعت دو بعد از ظهر جابجا کنم؟');
    assert.equal((await tool('r2', 'reschedule_appointment', { appointment_id: 'appt-1', new_start_iso: slots[1].start_iso })).ok, true);
  });

  it('a read-back and the booking in one breath is held each time (twice a call), even after an earlier hold', async () => {
    const slots = [{ start_iso: '2026-11-02T19:00:00.000Z', local_time: '14:00', spoken: 'ساعت دو بعد از ظهر' }];
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: JSON.stringify(t.name === 'check_availability' ? { ok: true, day_spoken: 'دوشنبه دوم نوامبر', slots } : { ok: true }) })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const said = (text: string) => h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
    const over = () => h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await tool('c1', 'check_availability');
    await said('اصلاح مو با عرفان دوشنبه دوم نوامبر ساعت دو بعد از ظهر، درسته؟');
    assert.match((await tool('b1', 'book_appointment', { start_iso: slots[0].start_iso })).hint, /same breath/);
    await over();
    await said('بسیار خب. دوشنبه دوم نوامبر ساعت دو بعد از ظهر، درسته؟');
    assert.match((await tool('b2', 'book_appointment', { start_iso: slots[0].start_iso })).hint, /same breath/, 'held again: the caller has not said yes');
    await over();
    await said('بله؟'); await over(); // the caller's yes, then the booking in its own turn
    assert.equal((await tool('b3', 'book_appointment', { start_iso: slots[0].start_iso })).ok, true);
  });

  it('cancel_appointment only after a question about that one appointment: the list of the caller\'s appointments is not it (once)', async () => {
    const appts = [{ appointment_id: 'a1', local_time: '09:00' }, { appointment_id: 'a2', local_time: '14:30' }];
    const sent: string[] = [];
    const sentArgs: any[] = [];
    const h = harness(OPEN, (list) => list.map((t) => { sent.push(t.name); sentArgs.push(t.args); return { toolCallId: t.id, name: t.name, result: JSON.stringify(t.name === 'find_my_appointments' ? { ok: true, appointments: appts } : { ok: true }) }; }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const tool = async (id: string, name: string, args: unknown = {}) => {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }));
      await new Promise((r) => setImmediate(r));
      return h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    };
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    const found = await tool('f1', 'find_my_appointments');
    assert.deepEqual(found.appointments.map((a: any) => a.appointment_id), ['appt-1', 'appt-2'], 'Gemini gets short names, never the long ids');
    await turn('دو تا نوبت دارید: جمعه ساعت نه صبح و جمعه ساعت دو و نیم. کدوم رو می‌خواید لغو کنید؟');
    assert.equal((await tool('c1', 'cancel_appointment', { appointment_id: 'appt-2' })).reason, 'confirm_first', 'the list is not the yes');
    assert.ok(!sent.includes('cancel_appointment'), 'not sent to barber-core');
    await turn('نوبت جمعه ساعت دو و نیم با عرفان رو لغو کنم؟');
    // a made-up id (the AI once sent one no tool gave): it is told the real ones, nothing is sent
    const bad = await tool('c3', 'cancel_appointment', { appointment_id: 'd720286b-made-up' });
    assert.equal(bad.reason, 'unknown_appointment_id');
    assert.match(bad.hint, /appt-1 .*appt-2 /);
    assert.ok(!sent.includes('cancel_appointment'));
    assert.equal((await tool('c2', 'cancel_appointment', { appointment_id: 'appt-2' })).ok, true);
    assert.equal(sentArgs.at(-1).appointment_id, 'a2', 'barber-core gets the real id');
  });

  it('one appointment found: any other id the AI sends means that one (it cannot copy a long id)', async () => {
    const sentArgs: any[] = [];
    const h = harness(OPEN, (list) => list.map((t) => { sentArgs.push([t.name, t.args]); return { toolCallId: t.id, name: t.name, result: JSON.stringify(t.name === 'find_my_appointments' ? { ok: true, appointments: [{ appointment_id: 'df354ab7-real' }] } : { ok: true }) }; }));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'find_my_appointments', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'یک نوبت دارید، جمعه ساعت نه. لغوش کنم؟' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'cancel_appointment', args: { appointment_id: '3fa1690a-made-up' } }] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sentArgs.at(-1), ['cancel_appointment', { appointment_id: 'df354ab7-real' }]);
    assert.ok(h.logs.some(([e]) => e === 'appointment_id_guessed'));
  });

  it('end_call while the caller has not answered the AI\'s question ("Anything else? Goodbye.") is refused; after the answer it ends', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'm1', name: 'take_message', args: { message: 'x' } }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'کار دیگه‌ای دارید؟ خداحافظ.' } } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.reason, 'caller_not_answered');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: 'نه ممنون' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'خداحافظ.' } } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e2', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.ok, true, 'the caller said no: the call ends');
  });

  it('the AI asked and the caller says nothing for 5 s: it asks again; still nothing: the barber or a message', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).map((m) => m.clientContent.turns[0].parts[0].text);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'ai-turn' } }, 'Twilio says when the question has been played');
    clock.t += 4000; h.s.played(); // the question took 4 s to play: the wait starts now
    clock.t += 4000; h.s.fromCaller(silent);
    assert.equal(said().length, 1, 'only 4 s since the question was heard');
    clock.t += 2000; h.s.fromCaller(silent);
    assert.match(said()[1], /5 seconds.*Say out loud now only your last question again.*never say they have not answered/s);
    clock.t += 3000; h.s.fromCaller(silent);
    assert.equal(said().length, 2, 'only 3 s after the re-ask');
    await speak(h); await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.match(said()[2], /ask your last question once more, in other short words, and give the choices.*«امروز، فردا، یا روز دیگه؟»/s);
    assert.match(said()[2], /Only if a tool already said this booking cannot be done.*connect you to the barber, or leave a message.*only if the salon is open/s, 'connect or message only after a no');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 3, 'at most 2 re-asks; then the 30 s silence rule ends the call');
    assert.deepEqual(h.logs.filter(([e]) => e === 'reask').map(([, d]) => d.n), [1, 2]);
    assert.ok(h.logs.filter(([e]) => e === 'reask').every(([, d]) => typeof d.loudMsAgo === 'number'), 'how long since the line was loud');
    // the caller answers and the AI answers them: the count starts again
    h.s.fromCaller(loud);
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 4);
  });

  it('logs how long the start took: barber-core, Gemini ready, the first audio the caller hears', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    const start = h.s.start('MZ1', ids);
    clock.t += 1200; await start;
    h.gem().onOpen();
    clock.t += 800; await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    clock.t += 1500; await h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] } } }));
    assert.deepEqual(h.logs.find(([e]) => e === 'call_date'), ['call_date', { now: '', days: '' }]);
    assert.deepEqual(h.logs.filter(([e]) => e === 'start_timing').map(([, d]) => [d.step, d.ms, d.retried]), [
      ['core_answered', 1200, false], ['gemini_ready', 2000, false], ['first_audio', 3500, false],
    ]);
  });

  it('the opening is our ready-made audio, word for word: played first; Gemini knows from its instructions and gets no turn; the caller is heard after it', async () => {
    const asked: string[] = [];
    const audio = Buffer.alloc(16000, 0x7f).toString('base64'); // 2 s of mu-law
    const h = harness(OPEN, () => [], undefined, async (text) => { asked.push(text); return audio; });
    await h.s.start('MZ1', ids);
    assert.deepEqual(asked, [OPEN.assistantOverrides.firstMessage], 'made while Gemini connects');
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await new Promise((r) => setImmediate(r));
    const media = h.sentToTwilio.filter((m) => m.event === 'media');
    assert.equal(media.map((m) => m.media.payload).join(''), audio, 'the whole opening, in order');
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'opening' } });
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, 0, 'no text turn: it was answered as if the caller had spoken');
    assert.match(h.sentToGemini[0].setup.systemInstruction.parts[0].text, /phone system plays your opening.*این تماس ممکن است ضبط شود.*Never say it yourself/s);
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160, 0x7f)).toString('base64'));
    assert.equal(h.sentToGemini.filter((m) => m.realtimeInput).length, 0, 'not while it plays');
    h.s.played('opening');
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.filter((m) => m.realtimeInput).length, 1);
    assert.ok(h.logs.some(([e, d]) => e === 'opening_played' && d.source === 'tts'));
    // a 1007 retry: the new session is told again, the caller does not hear it twice
    h.sockets[0].onClose(1007);
    h.sockets[1].onOpen();
    await h.sockets[1].onMessage(JSON.stringify({ setupComplete: {} }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToTwilio.filter((m) => m.event === 'media').length, media.length, 'not played again');
  });

  it('the AI asked its question, then set the language: the rest of that turn (its repeat) is not played; the next turn is', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true,"language":"fa-IR"}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const media = () => h.sentToTwilio.filter((m) => m.event === 'media').length;
    const audio = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } } });
    await h.gem().onMessage(audio);
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'ما دو تا آرایشگر داریم، عرفان و علیرضا. کدوم رو می‌خواید؟' } } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'l1', name: 'set_caller_language', args: { language: 'fa-IR' } }] } }));
    await new Promise((r) => setImmediate(r));
    const before = media();
    await h.gem().onMessage(audio); // the same question again
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'ما دو تا آرایشگر داریم، عرفان و علیرضا. کدوم رو می‌خواید؟' } } }));
    assert.equal(media(), before, 'the repeat is not played');
    assert.ok(h.logs.some(([e]) => e === 'repeat_muted'));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await h.gem().onMessage(audio); // the next turn (an answer to the caller) is heard
    assert.equal(media(), before + 1);
  });

  it('Gemini closes mid-call: its code and reason go into the call\'s text (the report says why it ended)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    (h.gem() as any).onClose(1011, 'Internal error encountered.');
    await new Promise((r) => setImmediate(r));
    await h.s.finish();
    const report = h.core.filter((c: any) => c[0] === 'end').at(-1)[1];
    assert.equal(report.endedReason, 'gemini-closed');
    assert.ok(report.transcript.some((l: any) => l.speaker === 'system' && l.body === 'gemini_closed {"code":1011,"reason":"Internal error encountered."}'));
  });

  it('the opening audio is asked from barber-core with the voice; stored audio plays without text-to-speech; new audio is kept there', async () => {
    let made = 0;
    const stored = Buffer.alloc(8000, 0x7f).toString('base64');
    const h = harness({ ...OPEN, openingAudio: stored }, () => [], undefined, async () => { made++; return 'x'; });
    await h.s.start('MZ1', ids);
    assert.deepEqual(h.core[1], ['voice', 'Kore'], 'barber-core is told the voice');
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await new Promise((r) => setImmediate(r));
    assert.equal(made, 0, 'no text-to-speech: barber-core had it');
    assert.equal(h.sentToTwilio.filter((m) => m.event === 'media').map((m) => m.media.payload).join(''), stored);
    // a salon without stored audio: made once and kept in barber-core
    const fresh = Buffer.alloc(8000, 0x7e).toString('base64');
    const h2 = harness(OPEN, () => [], undefined, async () => fresh);
    await h2.s.start('MZ1', ids);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h2.core.find(([k]) => k === 'saveOpening'), ['saveOpening', { voice: 'Kore', text: OPEN.assistantOverrides.firstMessage, audio: fresh }]);
  });

  it('no ready-made opening (TTS failed): Gemini says it, as before', async () => {
    const h = harness(OPEN, () => [], undefined, async () => null);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await new Promise((r) => setImmediate(r));
    assert.match(h.sentToGemini.at(-1).clientContent.turns[0].parts[0].text, /Say exactly this.*این تماس ممکن است ضبط شود/s);
    assert.equal(h.sentToTwilio.length, 0);
  });

  it('no tool runs before the AI starts the opening (the caller would wait in silence and miss the disclosure)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'p1', name: 'previous_visit_reminder', args: {} }] } }));
    assert.equal(h.core.filter(([k]) => k === 'tools').length, 0, 'barber-core is not asked');
    const r = h.sentToGemini.at(-1).toolResponse.functionResponses[0];
    assert.equal(r.response.reason, 'say_opening_first');
    assert.match(r.response.hint, /این تماس ممکن است ضبط شود/);
    assert.deepEqual(h.logs.find(([e]) => e === 'tool_before_opening'), ['tool_before_opening', { tools: ['previous_visit_reminder'] }]);
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'p2', name: 'previous_visit_reminder', args: {} }] } }));
    assert.equal(h.core.filter(([k]) => k === 'tools').length, 1, 'once the opening is being said, the tool runs');
  });

  it('a message passed on: the AI is told to say so first, then one goodbye, then end_call', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true,"message_id":"m1"}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'm1', name: 'take_message', args: { message: 'wants Alireza tomorrow; please call back' } }] } }));
    await new Promise((r) => setImmediate(r));
    const r = h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    assert.equal(r.ok, true);
    assert.match(r.next, /If you have not told the caller yet.*If you already said it, say nothing more/s);
  });

  it('a long pause after a tool is split in the logs: barber-core (tool_timing) and Gemini (gemini_reply)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, (list) => { clock.t += 2500; return list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })); }, clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'b1', name: 'book_appointment', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    clock.t += 9000; await speak(h);
    await speak(h);
    assert.deepEqual(h.logs.find(([e]) => e === 'tool_timing'), ['tool_timing', { tools: ['book_appointment'], ms: 2500 }]);
    assert.deepEqual(h.logs.filter(([e]) => e === 'gemini_reply'), [['gemini_reply', { ms: 9000 }]]);
  });

  it('end_call mid-sentence: the rest of the goodbye still plays; a later goodbye turn never does; the call ends when it was played', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'm1', name: 'take_message', args: { message: 'x' } }] } }));
    await new Promise((r) => setImmediate(r));
    await speak(h); // "Your message is passed on, they will..."
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.match(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.note, /Say nothing more/);
    const media = () => h.sentToTwilio.filter((m) => m.event === 'media').length;
    const before = media();
    await speak(h); // "...call you back. Goodbye." (same turn, after the tool call)
    assert.equal(media(), before + 1, 'the end of the sentence is not cut');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'goodbye' } });
    await speak(h); // a second goodbye in a new turn
    assert.equal(media(), before + 1, 'a second goodbye is dropped');
    assert.equal(h.updates.length, 0, 'not hung up before Twilio played the goodbye');
    h.s.played('goodbye');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1, 'hung up once the goodbye was played');
  });

  it('the caller\'s language from barber-core is fixed for Gemini (no answer asked for); a refused language changes nothing', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: t.args.language === 'fa-IR' ? '{"ok":true,"language":"fa-IR","saved":true}' : '{"ok":false,"reason":"unsupported_language"}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'l1', name: 'set_caller_language', args: { language: 'fa-IR', how: 'detected' } }] } }));
    await new Promise((r) => setImmediate(r));
    const answer = h.sentToGemini.at(-1).toolResponse.functionResponses[0].response;
    assert.equal(answer.ok, true);
    assert.match(answer.next, /speaks Persian \(Farsi\).*answer only in Persian/s, 'told in the tool answer, not as a separate turn');
    assert.match(answer.next, /Say nothing more now: no new question.*wait silently for the caller's answer/, 'no second question after it («کدوم رو ترجیح می‌دید؟برای چه خدمتی؟»)');
    assert.deepEqual(h.logs.find(([e]) => e === 'language_locked'), ['language_locked', { language: 'fa-IR' }]);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'l2', name: 'set_caller_language', args: { language: 'fr' } }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.next, undefined);
    assert.equal(h.logs.filter(([e]) => e === 'language_locked').length, 1);
  });

  it('Gemini says nothing to a re-ask: the next step still comes, then the goodbye and the hang-up (never a silent line)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).length;
    clock.t += 6000; h.s.fromCaller(silent);
    assert.equal(said(), 2, 're-ask 1');
    clock.t += 6000; h.s.fromCaller(silent);
    assert.equal(said(), 3, 're-ask 2, though Gemini said nothing');
    assert.ok(h.logs.some(([e]) => e === 'nudge_unanswered'));
    clock.t += 16000; h.s.fromCaller(silent);
    assert.equal(said(), 4, 'the goodbye');
    const fallback = h.timers.at(-1)!;
    assert.equal(fallback.ms, 15_000, 'hung up even if Gemini never says it');
    fallback.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1);
  });

  it('a wait that was never counted (the AI cut off, no turn end) starts again once the AI and the caller are quiet; noise never resets the re-asks', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).length;
    clock.t += 6000; h.s.fromCaller(silent); // re-ask 1
    await speak(h); // the AI starts it, then is cut off (no turnComplete)
    clock.t += 1000; h.s.fromCaller(loud); // echo or noise
    clock.t += 5000; h.s.fromCaller(silent);
    assert.equal(said(), 2, 'nothing counted yet: the AI spoke 6 s ago');
    clock.t += 4000; h.s.fromCaller(silent);
    assert.ok(h.logs.some(([e]) => e === 'wait_restarted'));
    clock.t += 6000; h.s.fromCaller(silent);
    assert.equal(said(), 3, 're-ask 2: the noise did not reset the count');
  });

  it('the caller answered quietly but Gemini heard it (its transcription): no re-ask, so the AI does not repeat its question', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    assert.deepEqual(h.sentToGemini[0].setup.inputAudioTranscription, {});
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await talked(h); // "With Erfan, right?"
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    clock.t += 1500; await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: 'بله' } } }));
    clock.t += 6000; h.s.fromCaller(silent);
    assert.ok(!h.logs.some(([e]) => e === 'reask'), 'the caller answered: no re-ask');
  });

  it('a speakerphone voice (quieter than a handset) still counts as the caller speaking: no re-ask over it', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const level = (v: number) => { const b = Buffer.alloc(320); for (let i = 0; i < 160; i++) b.writeInt16LE(i % 2 ? v : -v, i * 2); return pcm16ToMulaw(b).toString('base64'); };
    for (let i = 0; i < 6; i++) { clock.t += 1000; h.s.fromCaller(level(1000)); } // 6 s of a quiet "I'd like an appointment"
    assert.ok(!h.logs.some(([e]) => e === 'reask'), 'no re-ask while the caller speaks');
  });

  it('"booked" with no tool ok is caught from the AI\'s own words and corrected after its turn; the call does not end on it', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    assert.deepEqual(h.sentToGemini[0].setup.outputAudioTranscription, {}, 'the AI\'s words come as text too');
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'قرار ملاقات شما فردا ساعت ۱۱ ' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'با عرفان ثبت شد.' } } }));
    assert.ok(!h.logs.some(([e]) => e === 'false_claim_corrected'), 'not in the middle of the turn: the tool may come after the words');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    h.timers.filter((x) => x.ms === 3000).at(-1)!.fn(); // a little after the turn, still no tool
    const told = h.sentToGemini.filter((m) => m.clientContent).at(-1).clientContent;
    assert.match(told.turns[0].parts[0].text, /^Correction: nothing has been booked/);
    assert.ok(h.logs.some(([e]) => e === 'false_claim_corrected'));
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.reason, 'not_finished', 'not ended on a false "booked"');
    // after a real booking the same words are fine
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'b1', name: 'book_appointment', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    const before = h.sentToGemini.filter((m) => m.clientContent).length;
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'Your appointment is booked.' } } }));
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, before);
  });


  it('"booked" said just before the booking tool: no correction once the tool answered ok', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'وقتتون ثبت شد. چیز دیگه‌ای هست؟' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'b1', name: 'book_appointment', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    h.timers.filter((x) => x.ms === 3000).at(-1)!.fn();
    assert.ok(!h.logs.some(([e]) => e === 'false_claim_corrected'), 'the booking went through: no «هنوز ثبت نشده»');
  });

  it('times said before check_availability ever answered are corrected (the AI made them up); after a real check they are fine', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const corrections = () => h.sentToGemini.filter((m) => m.clientContent?.turns?.[0]?.parts?.[0]?.text?.startsWith('Correction: the times'));
    // a turn with no times (the usual-staff offer, a question) is fine
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'اصلاح مو با عرفان، مثل دفعهٔ قبل. برای چه روزی وقت می‌خواهید؟' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.equal(corrections().length, 0);
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'عرفان ساعت 9:30 صبح، 10:30 یا 11:30 وقت داره.' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.equal(corrections().length, 1, 'made-up times are corrected');
    assert.ok(h.logs.some(([e]) => e === 'unchecked_times_corrected'));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'check_availability', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'Erfan has 9:30 AM or 1:30 PM.' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.equal(corrections().length, 1, 'times from check_availability are fine');
  });

  it('no re-ask while a tool runs or after the goodbye', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    let release: () => void = () => {};
    (h as any).s.deps.core.tools = () => new Promise((r) => { release = () => r([]); });
    const running = h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 't1', name: 'check_availability', args: {} }] } }));
    clock.t += 10000; h.s.fromCaller(silent);
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, 1, 'the tool is running: no re-ask');
    release(); await running;
  });

  it('end_call before the goodbye: the line stays open until the goodbye is fully said (not cut mid-sentence)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } })); // a new turn: end_call comes first
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1b', name: 'end_call' }] } })); // the second one is accepted
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 0, 'the goodbye may still be playing at Twilio');
    h.s.played('goodbye');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1, 'the line is hung up once, when the goodbye was played');
  });

  it('Gemini refuses the session at start (1007): the same session is opened once more, the opening is said again, the call is not dropped', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    h.sockets[0].onClose(1007);
    assert.equal(h.sockets.length, 2, 'a second session is opened');
    assert.equal(h.updates.length, 0, 'the line stays open');
    h.sockets[1].onOpen();
    await h.sockets[1].onMessage(JSON.stringify({ setupComplete: {} }));
    const openings = h.sentToGemini.filter((m) => m.clientContent);
    assert.equal(openings.length, 2, 'the opening is said again on the new session');
  });

  it('Gemini closes mid-call (1007): a new session with the full setting and the conversation so far, no new greeting (twice a call)', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true,"language":"fa-IR"}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    await h.gem().onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: 'یه appointment می‌خواستم' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: 'برای چه روزی می‌خواید؟' } } }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    h.sockets[0].onClose(1007, 'The audio content type (CONTENT_TYPE_AUDIO) is not supported for this model configuration.');
    assert.equal(h.sockets.length, 2, 'a second session');
    assert.equal(h.updates.length, 0, 'the line stays open');
    h.sockets[1].onOpen();
    const setup = h.sentToGemini.filter((m) => m.setup).at(-1).setup;
    assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription && setup.realtimeInputConfig, 'the full setting: the call keeps its text');
    await h.sockets[1].onMessage(JSON.stringify({ setupComplete: {} }));
    const note = h.sentToGemini.at(-1).clientContent.turns[0].parts[0].text;
    assert.match(note, /connection was renewed/);
    assert.match(note, /Caller: یه appointment می‌خواستم/);
    assert.match(note, /You: برای چه روزی می‌خواید؟/);
    assert.match(note, /never greet again/);
    assert.ok(h.logs.some(([e, d]) => e === 'gemini_retry' && d.reason === 'closed mid-call'));
    h.sockets[1].onClose(1007);
    assert.equal(h.sockets.length, 3, 'once more');
    h.sockets[2].onClose(1007);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1, 'a third time ends the call');
  });

  it('a second 1007 in the same call is not retried again: the call ends as before', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    h.sockets[0].onClose(1007);
    h.sockets[1].onClose(1007);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sockets.length, 2, 'no third session');
    assert.equal(h.updates.length, 1, 'the line is hung up');
  });

  it('when Gemini refuses the full setting (1007), the retry uses the plain setting (no activity or compression options)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    const full = h.sentToGemini[0].setup;
    assert.ok(full.realtimeInputConfig && full.contextWindowCompression, 'the first try carries the full setting');
    h.sockets[0].onClose(1007);
    h.sockets[1].onOpen();
    const plain = h.sentToGemini[1].setup;
    assert.equal(plain.realtimeInputConfig, undefined, 'the retry has no activity options');
    assert.equal(plain.contextWindowCompression, undefined, 'the retry has no compression');
    assert.ok(plain.tools && plain.systemInstruction, 'the retry keeps the tools and the prompt');
  });

  it('an early end_call (nothing booked, no message) is refused once; after a booking it ends the call', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: t.name === 'book_appointment' ? '{"ok":true}' : '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.ok, false, 'refused the first time');
    assert.equal(h.timers.filter((t) => t.ms === 15000).length, 0, 'no hang-up scheduled');
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e2', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.ok, true, 'allowed the second time');
  });

  it('after a booking, end_call ends the call at once', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true,"appointment_summary":"x"}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await speak(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'b1', name: 'book_appointment', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses.at(-1).response.ok, true);
  });

  it('a goodbye after the work is done hangs up once it is played, even without end_call; a goodbye with a question does not', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name, result: '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
    const turn = async (text: string) => {
      await h.gem().onMessage(JSON.stringify({ serverContent: { outputTranscription: { text } } }));
      await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    };
    await turn('خدانگهدار. کار دیگه‌ای دارید؟');
    assert.ok(!h.logs.some(([e]) => e === 'goodbye_heard'), 'nothing done yet');
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'r1', name: 'take_message', args: { message: 'x' } }] } }));
    await new Promise((r) => setImmediate(r));
    await turn('خدانگهدار. کار دیگه‌ای دارید؟');
    assert.ok(!h.logs.some(([e]) => e === 'goodbye_heard'), 'a question is still waiting for an answer');
    await turn('خدانگهدار.');
    assert.ok(h.logs.some(([e]) => e === 'goodbye_heard'));
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'goodbye' } }, 'hangs up once Twilio played it');
  });

  it('40 seconds before the call cap the AI asks one question (finish, or a message), waits for the answer, and may then end at once', async () => {
    const h = harness(OPEN); // maxDurationSeconds 120
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await speak(h);
    const warn = h.timers.find((t) => t.ms === 80_000);
    assert.ok(warn, 'a warning 40 s before the 120 s cap: time enough to take a message');
    warn!.fn();
    const last = h.sentToGemini.at(-1).clientContent.turns[0].parts[0].text;
    assert.match(last, /40 seconds.*message.*wait for the answer.*end_call/s);
    assert.match(last, /only if the salon is open/); // no transfer offer after hours
    assert.match(last, /never.*goodbye.*same turn as a question/i);
    assert.deepEqual(h.logs.find(([e]) => e === 'time_nudge'), ['time_nudge', { secondsLeft: 40 }]);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response.ok, true, 'no end guard after the warning');
  });
});
