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
    assert.deepEqual(h.core.at(-1), ['end', { startedAt: '2026-10-22T15:00:00.000Z', endedAt: '2026-10-22T15:00:00.000Z', endedReason: 'assistant-forwarded-call' }]);
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

  it('no answer to the question and both re-asks: 15 s later the AI thanks the caller and ends (once)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
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
    assert.deepEqual(h.logs.find(([e]) => e === 'silence_nudge'), ['silence_nudge', { silentSeconds: 16 }]);
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

  it('a quiet caller the AI answers, or a long tool run, is never taken for silence (no goodbye mid-booking)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
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

  it('the AI asked and the caller says nothing for 5 s: it asks again; still nothing: the barber or a message', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await heard(h);
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
    assert.match(said()[2], /one short question only.*connect you to the barber, or leave a message.*only if the salon is open/s);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 3, 'at most 2 re-asks; then the 30 s silence rule ends the call');
    assert.deepEqual(h.logs.filter(([e]) => e === 'reask'), [['reask', { n: 1 }], ['reask', { n: 2 }]]);
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
    assert.match(r.next, /tell the caller the barber will get their message.*goodbye \(only once/s);
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
