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
  if (!/^https:\/\/[^\s/]+$/.test(publicUrl)) throw new Error('PUBLIC_URL must be https://<host>');
  const coreWebhookUrl = need('CORE_WEBHOOK_URL');
  if (!/^https:\/\/[^\s]+\/api\/webhooks\/vapi$/.test(coreWebhookUrl)) throw new Error('CORE_WEBHOOK_URL must be https://<barber-core site>/api/webhooks/vapi');
  const coreWebhookSecret = need('CORE_WEBHOOK_SECRET');
  const streamSecret = need('STREAM_SECRET');
  if (coreWebhookSecret.length < 32 || streamSecret.length < 32) throw new Error('CORE_WEBHOOK_SECRET and STREAM_SECRET need 32+ characters');
  return {
    port: Number(env.PORT ?? 8080) || 8080, publicUrl,
    twilioAccountSid: need('TWILIO_ACCOUNT_SID'), twilioAuthToken: need('TWILIO_AUTH_TOKEN'),
    coreWebhookUrl, coreWebhookSecret, streamSecret,
    geminiApiKey: need('GEMINI_API_KEY'), geminiModel: need('GEMINI_LIVE_MODEL'), geminiVoice: env.GEMINI_VOICE?.trim() || 'Kore',
  };
}
