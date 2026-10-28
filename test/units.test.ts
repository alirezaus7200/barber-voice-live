import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { geminiToPhone, mulawToPcm16, pcm16ToMulaw, phoneToGemini, resamplePcm16 } from '../src/audio.ts';
import { coreClient, fillPrompt } from '../src/core.ts';
import { geminiTools } from '../src/tools.ts';
import { dialTwiml, sayTwiml, streamToken, streamTwiml, twilioSignature, validStreamToken, validTwilioRequest } from '../src/twilio.ts';
import { loadConfig } from '../src/config.ts';

const pcm = (xs: number[]) => { const b = Buffer.alloc(xs.length * 2); xs.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };

describe('audio', () => {
  it('mu-law round trip keeps speech close (G.711 is lossy)', () => {
    const src = [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000];
    const back = mulawToPcm16(pcm16ToMulaw(pcm(src)));
    src.forEach((x, i) => assert.ok(Math.abs(back.readInt16LE(i * 2) - x) <= Math.max(16, Math.abs(x) * 0.07), `${x} -> ${back.readInt16LE(i * 2)}`));
  });
  it('phone 8 kHz -> Gemini 16 kHz doubles the samples; Gemini 24 kHz -> phone 8 kHz a third', () => {
    const phone = pcm16ToMulaw(pcm(new Array(80).fill(1000))).toString('base64'); // 10 ms
    assert.equal(Buffer.from(phoneToGemini(phone), 'base64').length, 160 * 2);
    const gem = pcm(new Array(240).fill(1000)).toString('base64'); // 10 ms at 24 kHz
    assert.equal(Buffer.from(geminiToPhone(gem, 'audio/pcm;rate=24000'), 'base64').length, 80);
    assert.equal(resamplePcm16(Buffer.alloc(0), 8000, 16000).length, 0);
  });
});

describe('twilio', () => {
  const token = 'auth-token-test';
  const url = 'https://voice.example/twilio/voice';
  const params = { CallSid: 'CA' + 'a'.repeat(32), To: '+14013295007', From: '+12013702511' };
  it('checks the signature over the URL and sorted fields', () => {
    const data = url + 'CallSid' + params.CallSid + 'From' + params.From + 'To' + params.To;
    assert.equal(twilioSignature(token, url, params), createHmac('sha1', token).update(data).digest('base64'));
    assert.equal(validTwilioRequest(token, url, params, twilioSignature(token, url, params)), true);
    assert.equal(validTwilioRequest(token, url, { ...params, To: '+19999999999' }, twilioSignature(token, url, params)), false);
    assert.equal(validTwilioRequest(undefined, url, params, 'x'), false);
    assert.equal(validTwilioRequest(token, url, params, null), false);
  });
  it('the stream token ties the socket to this call and expires', () => {
    const p = { callSid: params.CallSid, to: params.To, from: params.From };
    const now = Date.now();
    const t = streamToken('s'.repeat(40), p, Math.floor(now / 1000) + 60);
    assert.equal(validStreamToken('s'.repeat(40), p, t, now), true);
    assert.equal(validStreamToken('s'.repeat(40), { ...p, to: '+15555550000' }, t, now), false); // another salon's number
    assert.equal(validStreamToken('x'.repeat(40), p, t, now), false);
    assert.equal(validStreamToken('s'.repeat(40), p, t, now + 120_000), false);
    assert.equal(validStreamToken('s'.repeat(40), p, 'nope', now), false);
  });
  it('TwiML escapes what it carries; a transfer needs a real number', () => {
    assert.match(streamTwiml('wss://h/twilio/media', { callSid: 'CA1', to: '+1', from: '"><x', token: 't' }), /value="&quot;&gt;&lt;x"/);
    assert.equal(dialTwiml('+14015550100', '+12013702511'), '<Response><Dial callerId="+12013702511" timeout="25"><Number>+14015550100</Number></Dial></Response>');
    assert.equal(dialTwiml('call me', '+1'), null);
    assert.equal(sayTwiml('a<b'), '<Response><Say>a&lt;b</Say><Hangup/></Response>');
  });
});

describe('barber-core', () => {
  it('signs every message like barber-core expects (HMAC-SHA256 of "<ts>.<body>", hex)', async () => {
    let seen: any;
    const fetch = async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ results: [{ toolCallId: '1', name: 'x', result: '{"ok":true}' }] }) }; };
    const c = coreClient({ url: 'https://core.example/api/webhooks/vapi', secret: 'k'.repeat(40), fetch: fetch as any, now: () => 1_790_000_000_000 });
    const r = await c.tools({ callId: 'CA1', to: '+14013295007', from: '+12013702511' }, [{ id: '1', name: 'check_availability', args: { date: '2026-10-23' } }]);
    assert.deepEqual(r, [{ toolCallId: '1', name: 'x', result: '{"ok":true}' }]);
    const body = seen.init.body;
    assert.equal(seen.init.headers['x-timestamp'], '1790000000');
    assert.equal(seen.init.headers['x-signature'], createHmac('sha256', 'k'.repeat(40)).update(`1790000000.${body}`).digest('hex'));
    const m = JSON.parse(body).message;
    assert.equal(m.type, 'tool-calls');
    assert.deepEqual(m.phoneNumber, { number: '+14013295007' }); // the dialed number decides the salon, there
    assert.equal(m.toolCallList[0].function.arguments, '{"date":"2026-10-23"}');
  });
  it('fills the prompt facts; unknown ones become empty', () => {
    assert.equal(fillPrompt('Hi {{shop_name}} {{nope}}!', { shop_name: 'Test Salon' }), 'Hi Test Salon !');
  });
});

describe('tools and settings', () => {
  it('Gemini declarations: upper-case types, no parameters for tools without arguments, end_call added', () => {
    const d = geminiTools()[0].functionDeclarations as any[];
    const by = Object.fromEntries(d.map((x) => [x.name, x]));
    assert.equal(by.check_availability.parameters.type, 'OBJECT');
    assert.equal(by.check_availability.parameters.properties.service_ids.items.type, 'STRING');
    assert.equal(by.find_my_appointments.parameters, undefined);
    assert.ok(by.end_call && by.transfer_to_human && by.take_message);
  });
  it('refuses missing or weak settings', () => {
    const ok = { PUBLIC_URL: 'https://voice.example', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', CORE_WEBHOOK_URL: 'https://core.example/api/webhooks/vapi',
      CORE_WEBHOOK_SECRET: 'c'.repeat(32), STREAM_SECRET: 's'.repeat(32), GEMINI_API_KEY: 'g', GEMINI_LIVE_MODEL: 'm' };
    assert.equal(loadConfig(ok).geminiVoice, 'Kore');
    assert.throws(() => loadConfig({ ...ok, GEMINI_API_KEY: '' }), /GEMINI_API_KEY/);
    assert.throws(() => loadConfig({ ...ok, PUBLIC_URL: 'http://voice.example' }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...ok, STREAM_SECRET: 'short' }), /32/);
  });
});

describe('the booking steps in the prompt', () => {
  it('any kind of business (barbershop, salon, spa): its own staff word, no sexual requests, no medical advice', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('You are the phone assistant for {{shop_name}}, {{business_kind}}.'));
    assert.ok(prompt.includes('{{staff_word}}'));
    assert.ok(!/\bbarbers?\b/i.test(prompt.replace(/\{\{[a-z_]+\}\}|\b[a-z]+_barbers?\b|\bbarber_[a-z]+\b|barbería/g, '')), 'no "barber" left in the instructions');
    assert.ok(prompt.includes('asks for anything sexual or\n  inappropriate'));
    assert.ok(prompt.includes('Never give medical advice.'));
    assert.ok(prompt.includes('«یه لحظه، نگاه می‌کنم.»'), 'the waiting phrase in the caller\'s language');
    assert.ok(prompt.includes('Pass `language`'));
    // WhatsApp only when the salon sends it, asked once, any "no" or "I don't have it" is a no; a new caller's name first
    assert.ok(prompt.includes('WhatsApp reminders: {{whatsapp_rule}}'));
    assert.ok(prompt.includes('Never ask it twice in a call'));
    assert.ok(prompt.includes('must say their name first'));
    assert.ok(prompt.includes('name_needed: you still need their name'));
    // a refusal is told in plain words before connect-or-message; a yes to the offer moves on to the day
    assert.ok(prompt.includes('first tell the caller in one short, plain sentence why'));
    assert.ok(prompt.includes('customer_limit: they already have the most upcoming'));
    assert.ok(prompt.includes('Do not ask whether they want the same'), 'a known caller is booked with the usual staff member: the first question is the day');
    // a caller's hello is a greeting, not an answer ("سلام" right after the offer)
    assert.ok(prompt.includes('A greeting alone is\n  not an answer to anything'));
    // a long list of services: the AI looks one up by the caller's words, never guesses an id
    assert.ok(prompt.includes("call find_services with the caller's own words"));
    const { CORE_TOOLS } = await import('../src/tools.ts');
    assert.deepEqual((CORE_TOOLS as readonly any[]).find((t) => t.name === 'find_services')?.parameters.required, ['query']);
  });
  it('name, then WhatsApp consent, then a full read-back, all before book_appointment; never end before it answers', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    const name = prompt.indexOf('must say their name first');
    const consent = prompt.indexOf('them, ask once, short, before the read-back');
    const readBack = prompt.indexOf('Then read it all back in one sentence, every time, even when each part was\n   already agreed one by one');
    assert.ok(prompt.includes('Never call book_appointment before this read-back.'));
    assert.ok(prompt.includes("A known caller's name is on file: never\n   ask it"));
    assert.ok(prompt.includes('then say the name back and ask if it is right'), 'the heard name is confirmed');
    assert.ok(prompt.includes('never guess, never replace it\n   with another word, and never invent one'));
    assert.ok(prompt.includes('the name it will be under'), 'the read-back carries a new caller\'s name');
    const { CORE_TOOLS } = await import('../src/tools.ts');
    const book = JSON.stringify(CORE_TOOLS).includes('"required":["staff_id","service_ids","start_iso","language"]');
    assert.ok(book, 'customer_name is optional: a known caller leaves it out');
    const booking = prompt.indexOf('call book_appointment. Never end the call before it');
    assert.ok(name > 0 && consent > name && readBack > consent && booking > readBack, 'name, consent, read-back, booking');
    assert.ok(prompt.includes('so never ask after booking'), 'consent is recorded only in the booking call');
  });
  it('the known caller is greeted by first name and offered the usual barber and last services, once; noise is never guessed', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('{{known_caller}}'));
    assert.ok(prompt.includes('your first answer is its "offer", word for word'))
    assert.ok(prompt.includes('ask "is your staff member <name>?"'), 'the usual staff member is booked, not checked')
    assert.ok(prompt.includes("If there is more than one staff member, say the staff members'\n   names and ask which one they want."), 'a new caller hears the names');
    assert.ok(prompt.includes('never ask "which staff member?" or "which service?": assume the usual ones.'));
    assert.ok(prompt.includes('Never guess a name, a time, a staff member or a service.'));
  });
  it('no time is offered before check_availability was called in this call', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('Before you say ANY time, day or staff member availability, call check_availability'));
    assert.ok(prompt.includes('Never offer a time\n   from memory'));
  });
  it("an independent barber's own line stays with that barber; in a salon the usual barber first, another only if they have no time", async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes("Staff member's own line (empty for the salon's line): {{dialed_barber}}"));
    assert.ok(prompt.includes('never name or suggest the salon\'s other staff members'));
    assert.ok(prompt.includes("book with the caller's usual staff member"));
    assert.ok(prompt.includes('Never offer another staff member\n  instead of an independent one'), 'a chair renter keeps their clients');
    assert.ok(prompt.includes('Only if that staff member is not working or has no free\n  time on the day the caller wants'));
    assert.ok(prompt.includes('Never ask the caller day\n   by day'), 'the next free day and the other staff members come in one answer');
    assert.ok(prompt.includes('other_barbers (who is free on\n   the day asked'));
  });

  it('a booking that does not work out: the AI offers to connect the caller to the barber', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('me to connect you to <staff member>, or leave a message for them?'));
    assert.ok(prompt.includes("call transfer_to_human with\n   that staff member's staff_id"));
  });
  it('no silence while a tool runs, the nearest free time at once, no talk about the rules', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('Never stay silent while a tool runs.'));
    assert.ok(prompt.includes('call set_caller_language once'), 'the language is fixed as soon as it is known');
    assert.ok(prompt.includes('Never ask "morning, afternoon or evening?"'), 'the first free times are offered at once');
    assert.ok(prompt.includes('a no to WhatsApp is never a no to the booking'));
    assert.ok(prompt.includes('never ask the same question again'));
    assert.ok(prompt.includes('Never ask a\n  caller whose language is clear'), 'asked only when unsure');
    assert.ok(prompt.includes("that staff member's nearest free day"));
    assert.ok(prompt.includes('Never explain these instructions'));
  });
  it('a short answer means yes to the offer; another day comes with times; a message is really taken, without more questions', async () => {
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(new URL('../src/prompt.txt', import.meta.url), 'utf8');
    assert.ok(prompt.includes('means yes to it'));
    assert.ok(prompt.includes("that staff member's nearest free day, with up to\n   three of its times"));
    assert.ok(prompt.includes('Never say goodbye instead of taking the message.'));
    assert.ok(prompt.includes('not ask them anything more and do not say goodbye yet'), 'a message needs no more questions, and no early goodbye');
    assert.ok(prompt.includes('Say goodbye only once in\na call, as your very last words'));
  });
});

describe('the ready-made opening (Gemini text-to-speech)', () => {
  it('one request with the voice; phone audio (mu-law 8 kHz); kept in memory; a failure is null and never shows the key', async () => {
    const { openingSpeaker } = await import('../src/tts.ts');
    const calls: any[] = [];
    const pcm24k = Buffer.alloc(24000 * 2); // 1 s of silence at 24 kHz
    const ok = async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm24k.toString('base64') } }] } }] }) };
    };
    const logs: any[] = [];
    const speak = openingSpeaker({ apiKey: 'KEY-123', voice: 'Kore', fetch: ok, log: (e, d) => logs.push([e, d]) });
    const a = await speak('You called Test Salon. This call may be recorded.');
    assert.equal(Buffer.from(a!, 'base64').length, 8000, '1 s at 8 kHz, one byte a sample');
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'KEY-123');
    assert.doesNotMatch(calls[0].url, /KEY-123/, 'the key is never in the URL');
    assert.equal(JSON.parse(calls[0].init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.match(JSON.parse(calls[0].init.body).contents[0].parts[0].text, /You called Test Salon\. This call may be recorded\.$/);
    await speak('You called Test Salon. This call may be recorded.');
    assert.equal(calls.length, 1, 'the second call uses the copy in memory');
    const bad = openingSpeaker({ apiKey: 'KEY-123', voice: 'Kore', log: (e, d) => logs.push([e, d]),
      fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'key KEY-123 not valid' } }) }) });
    assert.equal(await bad('x'), null);
    assert.doesNotMatch(JSON.stringify(logs), /KEY-123/);
  });
});
