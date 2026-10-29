// Settings from the environment (.env locally, the host's settings in production). Secrets never in code.
export type Config = {
  port: number; publicUrl: string;
  twilioAccountSid: string; twilioAuthToken: string;
  coreWebhookUrl: string; coreWebhookSecret: string; streamSecret: string;
  geminiApiKey: string; geminiModel: string; geminiVoice: string;
  // how readily Gemini hears the start of the caller's speech (Cloud Run settings, no code change): unset = Gemini's own
  geminiStartSensitivity?: 'START_SENSITIVITY_HIGH' | 'START_SENSITIVITY_LOW'; geminiPrefixPaddingMs?: number;
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
    ...activitySettings(env),
  };
}

/** GEMINI_START_SENSITIVITY (HIGH or LOW) and GEMINI_PREFIX_PADDING_MS (0 to 1000): unset or wrong = Gemini's own. */
export function activitySettings(env: Record<string, string | undefined>): Pick<Config, 'geminiStartSensitivity' | 'geminiPrefixPaddingMs'> {
  const s = env.GEMINI_START_SENSITIVITY?.trim().toUpperCase();
  const p = env.GEMINI_PREFIX_PADDING_MS?.trim();
  const ms = p && /^\d{1,4}$/.test(p) && Number(p) <= 1000 ? Number(p) : undefined;
  return {
    ...(s === 'HIGH' || s === 'LOW' ? { geminiStartSensitivity: `START_SENSITIVITY_${s}` as const } : {}),
    ...(ms !== undefined ? { geminiPrefixPaddingMs: ms } : {}),
  };
}
