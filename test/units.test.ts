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
  it('Gemini declarations: upper-case types, no parameters for tools without arguments, local language and end_call tools added', () => {
    const d = geminiTools()[0].functionDeclarations as any[];
    const by = Object.fromEntries(d.map((x) => [x.name, x]));
    assert.equal(by.check_availability.parameters.type, 'OBJECT');
    assert.equal(by.check_availability.parameters.properties.service_ids.items.type, 'STRING');
    assert.equal(by.find_my_appointments.parameters, undefined);
    assert.deepEqual(by.set_caller_language.parameters.properties.language.enum, ['en', 'es', 'fa-IR']);
    assert.ok(by.set_caller_language && by.end_call && by.transfer_to_human && by.take_message);
  });
  it('refuses missing or weak settings', () => {
    const ok = { PUBLIC_URL: 'https://voice.example', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', CORE_WEBHOOK_URL: 'https://core.example/api/webhooks/vapi',
      CORE_WEBHOOK_SECRET: 'c'.repeat(32), STREAM_SECRET: 's'.repeat(32), GEMINI_API_KEY: 'g', GEMINI_LIVE_MODEL: 'm' };
    assert.equal(loadConfig(ok).geminiVoice, 'Kore');
    assert.equal(loadConfig(ok).port, 8888);
    assert.equal(loadConfig({ ...ok, PORT: '9123' }).port, 9123);
    assert.throws(() => loadConfig({ ...ok, GEMINI_API_KEY: '' }), /GEMINI_API_KEY/);
    assert.throws(() => loadConfig({ ...ok, PUBLIC_URL: 'http://voice.example' }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...ok, PUBLIC_URL: 'https://voice.example/مسیر' }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...ok, PORT: '0' }), /PORT/);
    assert.throws(() => loadConfig({ ...ok, STREAM_SECRET: 'short' }), /32/);
  });
});
