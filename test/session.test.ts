// A whole call with fake sockets: barber-core's opening, the setup sent to Gemini, audio both ways,
// a tool call through barber-core, a transfer to the salon, and the end-of-call report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallSession, type SessionDeps } from '../src/session.ts';
import { pcm16ToMulaw } from '../src/audio.ts';

function harness(startAnswer: any, toolAnswer: (list: any[]) => any[] = () => [], clock = { t: Date.parse('2026-10-22T15:00:00Z') }) {
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
      start: async (c: any) => { core.push(['start', c]); return startAnswer; },
      tools: async (c: any, list: any[]) => { core.push(['tools', list]); return toolAnswer(list); },
      end: async (c: any, x: any) => { core.push(['end', x]); return {}; },
    } as any,
    openGemini: (h) => { gem = h; sockets.push(h); return { send: (d) => sentToGemini.push(JSON.parse(d)), close: () => {} }; },
    updateCall: async (_sid, twiml) => { updates.push(twiml); return { ok: true }; },
    prompt: 'You answer for {{shop_name}}.', model: 'live-model', voice: 'Kore',
    setTimer: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clearTimer: () => {},
    now: () => new Date(clock.t), log: (event, data) => logs.push([event, data]),
  };
  const s = new CallSession(deps, { send: (d) => sentToTwilio.push(JSON.parse(d)), close: () => {} });
  return { s, sentToGemini, sentToTwilio, core, updates, timers, logs, sockets, gem: () => gem };
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
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini[2].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } } }));
    assert.equal(h.sentToTwilio[0].event, 'media');
    assert.equal(Buffer.from(h.sentToTwilio[0].media.payload, 'base64').length, 80);
    h.gem().onMessage(JSON.stringify({ serverContent: { interrupted: true } }));
    assert.equal(h.sentToTwilio[1].event, 'clear');
  });

  it('tools go to barber-core and their results back to Gemini; a yes from transfer_to_human moves the call', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: t.name === 'transfer_to_human' ? '{"ok":true,"transfer_to":"+14015550100"}' : '{"ok":true,"slots":[]}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
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

  it('after 30 seconds of silence from the caller, the AI thanks them and asks them to call again to book (once)', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    const silent = Buffer.alloc(160, 0xff).toString('base64'); // mu-law silence
    const loud = Buffer.alloc(160, 0x00).toString('base64'); // mu-law at full volume
    clock.t += 5000; h.s.fromCaller(loud); // the caller speaks: the clock restarts
    clock.t += 29000; h.s.fromCaller(silent);
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, 1, 'no nudge yet, 29 seconds of silence');
    clock.t += 2000; h.s.fromCaller(silent);
    clock.t += 1000; h.s.fromCaller(silent);
    const nudges = h.sentToGemini.filter((m) => m.clientContent);
    assert.equal(nudges.length, 2, 'the opening, then one nudge');
    assert.match(nudges[1].clientContent.turns[0].parts[0].text, /30 seconds.*call again.*end_call/s);
    assert.deepEqual(h.logs.find(([e]) => e === 'silence_nudge'), ['silence_nudge', { silentSeconds: 31 }]);
  });

  it('the AI asked and the caller says nothing for 7 s: it asks again; still nothing: the barber or a message', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    const loud = Buffer.alloc(160, 0x00).toString('base64');
    const said = () => h.sentToGemini.filter((m) => m.clientContent).map((m) => m.clientContent.turns[0].parts[0].text);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    assert.deepEqual(h.sentToTwilio.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'ai-turn' } }, 'Twilio says when the question has been played');
    clock.t += 4000; h.s.played(); // the question took 4 s to play: the wait starts now
    clock.t += 6000; h.s.fromCaller(silent);
    assert.equal(said().length, 1, 'only 6 s since the question was heard');
    clock.t += 2000; h.s.fromCaller(silent);
    assert.match(said()[1], /7 seconds.*question again/s);
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 2, 'the AI has not said the re-ask yet: no second one');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.match(said()[2], /connect you to the barber, or take a message.*only if the salon is open/s);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 3, 'at most 2 re-asks; then the 30 s silence rule ends the call');
    assert.deepEqual(h.logs.filter(([e]) => e === 'reask'), [['reask', { n: 1 }], ['reask', { n: 2 }]]);
    // the caller answers: the count starts again
    h.s.fromCaller(loud);
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    clock.t += 8000; h.s.fromCaller(silent);
    assert.equal(said().length, 4);
  });

  it('no re-ask while a tool runs or after the goodbye', async () => {
    const clock = { t: Date.parse('2026-10-22T15:00:00Z') };
    const h = harness(OPEN, () => [], clock);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    const silent = Buffer.alloc(160, 0xff).toString('base64');
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    let release: () => void = () => {};
    (h as any).s.deps.core.tools = () => new Promise((r) => { release = () => r([]); });
    const running = h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 't1', name: 'check_availability', args: {} }] } }));
    clock.t += 10000; h.s.fromCaller(silent);
    assert.equal(h.sentToGemini.filter((m) => m.clientContent).length, 1, 'the tool is running: no re-ask');
    release(); await running;
  });

  it('after end_call the line stays open until the goodbye is fully said (not cut mid-sentence)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1b', name: 'end_call' }] } })); // the second one is accepted
    await new Promise((r) => setImmediate(r));
    const before = h.timers.length;
    await h.gem().onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    await new Promise((r) => setImmediate(r));
    const hangUpTimer = h.timers.slice(before).find((t) => t.ms === 1500);
    assert.ok(hangUpTimer, 'hang up 1.5 s after the goodbye turn completes');
    hangUpTimer!.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updates.length, 1, 'the line is hung up once');
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
