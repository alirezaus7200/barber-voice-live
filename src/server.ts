// The phone server: Twilio calls POST /twilio/voice when someone dials a salon's number; we answer with
// TwiML that streams the call's audio to wss://<host>/twilio/media, where a CallSession joins it to
// Gemini Live. Needs a host that keeps WebSockets open for a whole call (not Vercel functions).
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { coreClient } from './core.ts';
import { CallSession } from './session.ts';
import { streamToken, streamTwiml, updateCall, validStreamToken, validTwilioRequest } from './twilio.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig(process.env);
const prompt = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8');
const core = coreClient({ url: cfg.coreWebhookUrl, secret: cfg.coreWebhookSecret });
const log = (event: string, data: Record<string, unknown>) => console.error(JSON.stringify({ event, ...data }));
const E164 = /^\+[1-9]\d{7,14}$/;

const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  let s = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { s += c; if (s.length > 50_000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => resolve(s));
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
  if (req.method !== 'POST' || !req.url?.startsWith('/twilio/voice')) { res.writeHead(404).end(); return; }
  try {
    const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const url = `${cfg.publicUrl}${req.url}`;
    if (!validTwilioRequest(cfg.twilioAuthToken, url, params, req.headers['x-twilio-signature'] as string ?? null)) {
      log('twilio_signature_rejected', {});
      res.writeHead(403).end(); return;
    }
    const p = { callSid: String(params.CallSid ?? ''), to: String(params.To ?? ''), from: E164.test(String(params.From ?? '')) ? String(params.From) : '' };
    if (!/^CA[0-9a-f]{32}$/i.test(p.callSid) || !E164.test(p.to)) { res.writeHead(400).end(); return; }
    const token = streamToken(cfg.streamSecret, p, Math.floor(Date.now() / 1000) + 120);
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(streamTwiml(`${cfg.publicUrl.replace(/^http/, 'ws')}/twilio/media`, { ...p, token }));
  } catch (e: any) {
    log('twilio_voice_failed', { error: String(e?.message ?? e) });
    res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ server, path: '/twilio/media', maxPayload: 1_000_000 });
wss.on('connection', (twilio) => {
  let session: CallSession | null = null;
  const send = { send: (d: string) => { if (twilio.readyState === WebSocket.OPEN) twilio.send(d); }, close: () => twilio.close() };
  twilio.on('message', async (raw) => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.event === 'start' && !session) {
      const c = m.start?.customParameters ?? {};
      const p = { callSid: String(c.callSid ?? ''), to: String(c.to ?? ''), from: String(c.from ?? '') };
      // only a stream we started for a Twilio-signed call is accepted
      if (!validStreamToken(cfg.streamSecret, p, c.token, Date.now())) { log('stream_token_rejected', {}); twilio.close(); return; }
      session = new CallSession({
        core, prompt, model: cfg.geminiModel, voice: cfg.geminiVoice, log,
        now: () => new Date(),
        setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
        updateCall: (callSid, twiml) => updateCall({ accountSid: cfg.twilioAccountSid, authToken: cfg.twilioAuthToken, callSid, twiml }),
        openGemini: (h) => {
          const ws = new WebSocket(
            'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
            { headers: { 'x-goog-api-key': cfg.geminiApiKey } },
          );
          ws.on('open', h.onOpen);
          ws.on('message', (d) => h.onMessage(String(d)));
          // Google's close code and reason (e.g. a wrong model name or key) show in the host's logs; never the key
          ws.on('close', (code, reason) => { log('gemini_closed', { code, reason: String(reason).slice(0, 300) }); h.onClose(); });
          ws.on('error', (e) => log('gemini_socket_error', { error: String(e.message) }));
          return { send: (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); }, close: () => ws.close() };
        },
      }, send);
      await session.start(String(m.start?.streamSid ?? ''), p);
    } else if (m.event === 'media' && typeof m.media?.payload === 'string') {
      session?.fromCaller(m.media.payload);
    } else if (m.event === 'stop') {
      await session?.finish();
    }
  });
  twilio.on('close', () => void session?.finish());
});

server.listen(cfg.port, () => log('listening', { port: cfg.port }));
