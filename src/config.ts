// Settings from the environment (.env locally, the host's settings in production). Secrets never in code.
export type Config = {
  port: number; publicUrl: string;
  twilioAccountSid: string; twilioAuthToken: string;
  coreWebhookUrl: string; coreWebhookSecret: string; streamSecret: string;
  geminiApiKey: string; geminiModel: string; geminiVoice: string;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set (see .env.example)`);
    return v;
  };
  const publicUrl = need('PUBLIC_URL').replace(/\/$/, '');
  let publicOrigin: URL;
  try { publicOrigin = new URL(publicUrl); } catch { throw new Error('PUBLIC_URL must be a valid HTTPS origin'); }
  if (!/^[\x00-\x7F]+$/.test(publicUrl) || publicOrigin.protocol !== 'https:' || publicOrigin.origin !== publicUrl || publicOrigin.username || publicOrigin.password) throw new Error('PUBLIC_URL must be a valid ASCII HTTPS origin');
  const coreWebhookUrl = need('CORE_WEBHOOK_URL');
  let coreUrl: URL;
  try { coreUrl = new URL(coreWebhookUrl); } catch { throw new Error('CORE_WEBHOOK_URL must be a valid HTTPS webhook URL'); }
  if (!/^[\x00-\x7F]+$/.test(coreWebhookUrl) || coreUrl.protocol !== 'https:' || !/^\/api\/webhooks\/vapi$/.test(coreUrl.pathname) || coreUrl.username || coreUrl.password || coreUrl.search || coreUrl.hash) throw new Error('CORE_WEBHOOK_URL must be an ASCII HTTPS /api/webhooks/vapi URL');
  const coreWebhookSecret = need('CORE_WEBHOOK_SECRET');
  const streamSecret = need('STREAM_SECRET');
  if (coreWebhookSecret.length < 32 || streamSecret.length < 32) throw new Error('CORE_WEBHOOK_SECRET and STREAM_SECRET need 32+ characters');
  return {
    port: parsePort(env.PORT), publicUrl,
    twilioAccountSid: need('TWILIO_ACCOUNT_SID'), twilioAuthToken: need('TWILIO_AUTH_TOKEN'),
    coreWebhookUrl, coreWebhookSecret, streamSecret,
    geminiApiKey: need('GEMINI_API_KEY'), geminiModel: need('GEMINI_LIVE_MODEL'), geminiVoice: env.GEMINI_VOICE?.trim() || 'Kore',
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 8888;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}
