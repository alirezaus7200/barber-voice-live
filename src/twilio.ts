// Twilio: the check that a webhook really comes from Twilio, the answer that connects the call's audio
// to our media socket, and moving a live call to the salon's own number (a transfer).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the full URL plus every POST field (sorted, name+value). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function validTwilioRequest(authToken: string | undefined, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * The answer to an incoming call: connect its audio to our socket. The dialed number, the caller and
 * the call id go along as stream parameters; they come from Twilio's signed request, never from the caller.
 */
export function streamTwiml(socketUrl: string, p: { callSid: string; to: string; from: string; token: string }): string {
  const param = (name: string, value: string) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(socketUrl)}">`
    + `${param('callSid', p.callSid)}${param('to', p.to)}${param('from', p.from)}${param('token', p.token)}</Stream></Connect></Response>`;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** Replaces what a live call is doing with `twiml` (Twilio's "modify a live call"). */
export async function updateCall(o: {
  accountSid: string; authToken: string; callSid: string; twiml: string; fetch?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await (o.fetch ?? fetch)(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}/Calls/${encodeURIComponent(o.callSid)}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Twiml: o.twiml }).toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.ok ? { ok: true } : { ok: false, error: `twilio answered ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: `twilio not reached: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** The salon's own phone takes the call (a transfer); the salon sees the caller's number. */
export function dialTwiml(number: string, callerId: string): string | null {
  if (!E164.test(number)) return null;
  const id = E164.test(callerId) ? ` callerId="${xml(callerId)}"` : '';
  return `<Response><Dial${id} timeout="25"><Number>${xml(number)}</Number></Dial></Response>`;
}

/** A short notice in Twilio's own voice, then hang up (when the salon cannot take calls). */
export const sayTwiml = (text: string) => `<Response><Say>${xml(text.slice(0, 500))}</Say><Hangup/></Response>`;
export const hangupTwiml = () => '<Response><Hangup/></Response>';

// The stream parameters carry a short-lived signature, so nobody can open our media socket and claim
// another salon's number: only the TwiML we answered to a Twilio-signed request has a valid one.
export function streamToken(secret: string, p: { callSid: string; to: string; from: string }, expires: number): string {
  return `${expires}.${createHmac('sha256', secret).update(`${expires}|${p.callSid}|${p.to}|${p.from}`).digest('hex')}`;
}

export function validStreamToken(secret: string, p: { callSid: string; to: string; from: string }, token: unknown, nowMs: number): boolean {
  if (typeof token !== 'string' || !/^\d{10}\.[0-9a-f]{64}$/.test(token)) return false;
  const expires = Number(token.slice(0, 10));
  if (expires * 1000 < nowMs) return false;
  const a = Buffer.from(streamToken(secret, p, expires));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
