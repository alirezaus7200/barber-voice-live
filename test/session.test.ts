// A whole call with fake sockets: barber-core's opening, the setup sent to Gemini, audio both ways,
// a tool call through barber-core, a transfer to the salon, and the end-of-call report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallSession, type SessionDeps } from '../src/session.ts';
import { pcm16ToMulaw } from '../src/audio.ts';

function harness(startAnswer: any, toolAnswer: (list: any[]) => any[] = () => []) {
  const sentToGemini: any[] = [];
  const sentToTwilio: any[] = [];
  const core: any[] = [];
  const updates: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let gem: any;
  const deps: SessionDeps = {
    core: {
      start: async (c: any) => { core.push(['start', c]); return startAnswer; },
      tools: async (c: any, list: any[]) => { core.push(['tools', list]); return toolAnswer(list); },
      end: async (c: any, x: any) => { core.push(['end', x]); return {}; },
    } as any,
    openGemini: (h) => { gem = h; return { send: (d) => sentToGemini.push(JSON.parse(d)), close: () => {} }; },
    updateCall: async (_sid, twiml) => { updates.push(twiml); return { ok: true }; },
    prompt: 'You answer for {{shop_name}}.', model: 'live-model', voice: 'Kore',
    setTimer: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clearTimer: () => {},
    now: () => new Date('2026-10-22T15:00:00Z'), log: () => {},
  };
  const s = new CallSession(deps, { send: (d) => sentToTwilio.push(JSON.parse(d)), close: () => {} });
  return { s, sentToGemini, sentToTwilio, core, updates, timers, gem: () => gem };
}
const ids = { callSid: 'CA' + '1'.repeat(32), to: '+14013295007', from: '+12013702511' };
const OPEN = { assistantId: 'x', assistantOverrides: { firstMessage: 'با Test Salon تماس گرفته‌اید. من دستیار هوش مصنوعی هستم و این تماس ممکن است ضبط شود.', maxDurationSeconds: 120, variableValues: { shop_name: 'Test Salon', default_language: 'en', is_test: false, call_languages: ['en', 'es', 'fa-IR', 'ar'] } } };

function finishOpeningAudio(h: ReturnType<typeof harness>) {
  h.gem().onMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] }, turnComplete: true } }));
  return h.sentToTwilio.at(-1);
}

async function acknowledgeOpening(h: ReturnType<typeof harness>) {
  const mark = finishOpeningAudio(h);
  assert.equal(mark.event, 'mark');
  await h.s.fromTwilioMark(mark.mark.name);
}

describe('a call', () => {
  it('says barber-core firstMessage exactly and waits for Twilio playback acknowledgment before sending caller audio', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    assert.deepEqual(h.core[0], ['start', { callId: ids.callSid, callSid: ids.callSid, to: ids.to, from: ids.from }]);
    h.gem().onOpen();
    const setup = h.sentToGemini[0].setup;
    assert.equal(setup.model, 'models/live-model');
    const instruction = setup.systemInstruction.parts[0].text;
    assert.match(instruction, /English, Spanish and Persian \(fa-IR\) are production languages/);
    assert.match(instruction, /Say it exactly as written, word for word/);
    assert.match(instruction, /Arabic test eligibility: not eligible/);
    assert.match(instruction, /Canonical barber-core firstMessage/);
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.ok(setup.tools[0].functionDeclarations.some((d: any) => d.name === 'book_appointment'));
    assert.ok(setup.tools[0].functionDeclarations.some((d: any) => d.name === 'set_caller_language'));
    assert.equal(h.timers[0].ms, 120_000); // the salon's call limit
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.length, 1, 'no audio is sent before Gemini setup completes');
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    const openingCommand = h.sentToGemini[1].clientContent.turns[0].parts[0].text;
    assert.ok(openingCommand.endsWith(JSON.stringify(OPEN.assistantOverrides.firstMessage)));
    assert.equal(h.sentToGemini.length, 2, 'first caller audio remains buffered while opening is playing');
    const mark = finishOpeningAudio(h);
    assert.equal(h.sentToTwilio[0].event, 'media');
    assert.equal(Buffer.from(h.sentToTwilio[0].media.payload, 'base64').length, 80);
    assert.equal(mark.event, 'mark');
    assert.equal(h.sentToGemini.length, 2, 'audio is still gated until Twilio confirms playback');
    await h.s.fromTwilioMark(mark.mark.name);
    assert.equal(h.sentToGemini[2].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    h.s.fromCaller(pcm16ToMulaw(Buffer.alloc(160)).toString('base64'));
    assert.equal(h.sentToGemini.length, 4);
    h.gem().onMessage(JSON.stringify({ serverContent: { interrupted: true } }));
    assert.equal(h.sentToTwilio.at(-1).event, 'clear');
  });

  it('passes each detected language through booking tools and supports switches in both directions', async () => {
    const h = harness(OPEN);
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await acknowledgeOpening(h);
    const transitions = ['en', 'es', 'fa-IR', 'en', 'fa-IR', 'es'];
    for (const [index, language] of transitions.entries()) {
      await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
        { id: `language-${index}`, name: 'set_caller_language', args: { language } },
        { id: `book-${index}`, name: 'book_appointment', args: {
          staff_id: 'barber-1', service_ids: ['cut-1'], start_iso: '2026-10-23T15:30:00-04:00', customer_name: 'Caller', language, whatsapp_consent: 'false',
        } },
      ] } }));
      await new Promise((r) => setImmediate(r));
      const toolRequest = h.core.filter((entry) => entry[0] === 'tools')[index][1][0];
      assert.equal(toolRequest.args.language, language);
    }
    await h.s.finish();
  });

  it('rejects every tool call before Twilio confirms the exact opening finished playing', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: t.name === 'transfer_to_human' ? '{"ok":true,"transfer_to":"+14015550100"}' : '{"ok":true}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'book-before-opening', name: 'book_appointment', args: { language: 'fa-IR' } },
      { id: 'transfer-before-opening', name: 'transfer_to_human', args: {} },
      { id: 'hangup-before-opening', name: 'end_call', args: {} },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.core.some((entry) => entry[0] === 'tools'), false);
    assert.equal(h.updates.length, 0);
    assert.deepEqual(h.sentToGemini.at(-1).toolResponse.functionResponses.map((x: any) => x.response.reason), ['opening_required', 'opening_required', 'opening_required']);

    const mark = finishOpeningAudio(h);
    assert.equal(h.core.some((entry) => entry[0] === 'tools'), false, 'Gemini turn completion alone does not open the gate');
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'still-before-playback', name: 'transfer_to_human', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.core.some((entry) => entry[0] === 'tools'), false, 'the sent mark is not enough; Twilio must acknowledge playback');
    assert.equal(h.updates.length, 0);
    await h.s.fromTwilioMark(mark.mark.name);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'book-after-opening', name: 'book_appointment', args: { language: 'fa-IR' } },
      { id: 'transfer-after-opening', name: 'transfer_to_human', args: {} },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.core.find((entry) => entry[0] === 'tools')[1].map((tool: any) => tool.name), ['book_appointment', 'transfer_to_human']);
    assert.equal(h.timers.at(-1)?.ms, 4000, 'transfer still waits for the assistant handoff message');
  });

  it('blocks Arabic tool language for real salons and permits it only with barber-core test eligibility', async () => {
    const production = harness(OPEN);
    await production.s.start('MZ1', ids);
    production.gem().onOpen();
    production.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await acknowledgeOpening(production);
    production.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'language-missing', name: 'find_my_appointments', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(production.core.some((entry) => entry[0] === 'tools'), false, 'business tools require a recognized and enabled caller language');
    production.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'set-arabic-prod', name: 'set_caller_language', args: { language: 'ar' } },
      { id: 'arabic-prod', name: 'find_my_appointments', args: {} },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(production.core.some((entry) => entry[0] === 'tools'), false);
    assert.deepEqual(production.sentToGemini.at(-1).toolResponse.functionResponses.map((x: any) => x.response), [
      { ok: false, reason: 'language_not_enabled' }, { ok: false, reason: 'language_not_enabled' },
    ]);
    production.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [{ id: 'arabic-prod-next', name: 'find_my_appointments', args: {} }] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(production.core.some((entry) => entry[0] === 'tools'), false, 'Arabic remains blocked for tools without a language argument');

    const testAnswer = { assistantId: 'x', assistantOverrides: { ...OPEN.assistantOverrides, variableValues: { ...OPEN.assistantOverrides.variableValues, is_test: true, call_languages: ['en', 'es', 'fa-IR', 'ar'] } } };
    const testSalon = harness(testAnswer);
    await testSalon.s.start('MZ1', ids);
    testSalon.gem().onOpen();
    testSalon.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    assert.match(testSalon.sentToGemini[0].setup.systemInstruction.parts[0].text, /Arabic test eligibility: eligible/);
    await acknowledgeOpening(testSalon);
    testSalon.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'set-arabic-test', name: 'set_caller_language', args: { language: 'ar' } },
      { id: 'arabic-test', name: 'book_appointment', args: { language: 'ar' } },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(testSalon.core.find((entry) => entry[0] === 'tools')[1][0].args.language, 'ar');

    const noArabicConfig = { assistantId: 'x', assistantOverrides: { ...OPEN.assistantOverrides, variableValues: { ...OPEN.assistantOverrides.variableValues, is_test: true, call_languages: ['en', 'es', 'fa-IR'] } } };
    const testWithoutArabic = harness(noArabicConfig);
    await testWithoutArabic.s.start('MZ1', ids);
    testWithoutArabic.gem().onOpen();
    testWithoutArabic.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    assert.match(testWithoutArabic.sentToGemini[0].setup.systemInstruction.parts[0].text, /Arabic test eligibility: not eligible/);
    await acknowledgeOpening(testWithoutArabic);
    testWithoutArabic.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'set-ar-no-config', name: 'set_caller_language', args: { language: 'ar' } },
      { id: 'book-ar-no-config', name: 'book_appointment', args: { language: 'ar' } },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(testWithoutArabic.core.some((entry) => entry[0] === 'tools'), false, 'a test flag alone does not enable Arabic');
  });

  it('tools go to barber-core and their results back to Gemini; a yes from transfer_to_human moves the call', async () => {
    const h = harness(OPEN, (list) => list.map((t) => ({ toolCallId: t.id, name: t.name,
      result: t.name === 'transfer_to_human' ? '{"ok":true,"transfer_to":"+14015550100"}' : '{"ok":true,"slots":[]}' })));
    await h.s.start('MZ1', ids);
    h.gem().onOpen();
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await acknowledgeOpening(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'set-en', name: 'set_caller_language', args: { language: 'en' } },
      { id: 'f1', name: 'check_availability', args: { date: '2026-10-23' } }, { id: 'f2', name: 'nope' },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.core[1], ['tools', [{ id: 'f1', name: 'check_availability', args: { date: '2026-10-23' } }]]);
    const resp = h.sentToGemini.at(-1).toolResponse.functionResponses;
    assert.deepEqual(resp, [
      { id: 'set-en', name: 'set_caller_language', response: { ok: true, language: 'en' } },
      { id: 'f1', name: 'check_availability', response: { ok: true, slots: [] } },
      { id: 'f2', name: 'nope', response: { ok: false, reason: 'unknown_tool' } },
    ]);
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
    h.gem().onMessage(JSON.stringify({ setupComplete: {} }));
    await acknowledgeOpening(h);
    await h.gem().onMessage(JSON.stringify({ toolCall: { functionCalls: [
      { id: 'set-en', name: 'set_caller_language', args: { language: 'en' } },
      { id: 'f1', name: 'book_appointment', args: {} }, { id: 'f2', name: 'end_call' },
    ] } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.sentToGemini.at(-1).toolResponse.functionResponses[1].response, { ok: false, reason: 'system_error' });
    h.timers.at(-1)!.fn();
    await new Promise((r) => setImmediate(r));
    await h.s.finish();
    assert.equal(h.core.filter((c) => c[0] === 'end').length, 1);
    assert.equal(h.core.at(-1)[1].endedReason, 'assistant-ended-call');
  });
});
