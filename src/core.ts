// barber-core, the booking system. Every booking rule, the salon from the dialed number, the tools and
// the call records live there; this server only carries the voice. We talk to barber-core's voice
// webhook (/api/webhooks/vapi) in the same signed format the voice platform uses: HMAC-SHA256 of
// "<timestamp>.<body>" in hex, headers x-signature and x-timestamp (CORE_WEBHOOK_SECRET).
import { createHmac } from 'node:crypto';

export type CallIds = { callId: string; to: string; from: string };
export type CoreClient = ReturnType<typeof coreClient>;

export function coreClient(o: { url: string; secret: string; fetch?: typeof fetch; now?: () => number; revision?: string }) {
  const send = async (message: Record<string, unknown>): Promise<any> => {
    const body = JSON.stringify({ message });
    const ts = String(Math.floor((o.now ?? Date.now)() / 1000));
    const res = await (o.fetch ?? fetch)(o.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': ts,
        'x-signature': createHmac('sha256', o.secret).update(`${ts}.${body}`, 'utf8').digest('hex'),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`barber-core answered ${res.status}`);
    return res.json();
  };
  const call = (c: CallIds) => ({ call: { id: c.callId }, phoneNumber: { number: c.to }, customer: { number: c.from } });
  return {
    /** The salon's opening, facts for the prompt and call length; or `error` (say it and hang up) / `destination` (AI off: forward). */
    start: (c: CallIds, voice?: string) => send({ type: 'assistant-request', ...call(c), ...(voice ? { voice } : {}) }),
    /** Keeps the opening's ready-made audio in barber-core for the next calls (only a real opening is kept). */
    saveOpening: (c: CallIds, x: { voice: string; text: string; audio: string }) => send({ type: 'opening-audio', ...call(c), ...x }),
    /** Runs the tools; answers [{ toolCallId, name, result (JSON string) }]. */
    tools: async (c: CallIds, list: { id: string; name: string; args: unknown }[]) => {
      const r = await send({
        type: 'tool-calls', ...call(c),
        toolCallList: list.map((t) => ({ id: t.id, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })),
      });
      return (Array.isArray(r?.results) ? r.results : []) as { toolCallId: string; name: string; result: string }[];
    },
    /** The call's end: its length and why it ended, and its text (barber-core keeps it for the superadmins). */
    end: (c: CallIds, x: { startedAt: string; endedAt: string; endedReason: string; transcript?: { speaker: string; body: string; at_ms: number }[] }) =>
      // this server's revision (Cloud Run's K_REVISION): barber-core's test checklist ticks a pass for it
      send({ type: 'end-of-call-report', ...call(c), ...x, ...(o.revision ? { voiceRevision: o.revision } : {}) }),
  };
}

/** The prompt template (barber-core docs/receptionist_prompt.md, section 2) with this call's facts. */
export function fillPrompt(template: string, facts: Record<string, unknown>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, k: string) => (facts[k] === undefined || facts[k] === null ? '' : String(facts[k])));
}
