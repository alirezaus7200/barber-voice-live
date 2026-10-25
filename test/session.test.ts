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
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'book_appointment', args: {} }, { id: 'f2', name: 'end_call' }] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.sentToGemini.at(-1).toolResponse.functionResponses[0].response, { ok: false, reason: 'system_error' });
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

  it('after end_call the line stays open until the goodbye is fully said (not cut mid-sentence)', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call' }] } }));
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
});
