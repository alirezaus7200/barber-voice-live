// The tools Gemini may call. They are barber-core's tools (src/voice/vapi-tools.ts there: names,
// descriptions and arguments must stay the same; barber-core checks every argument again). The salon,
// the caller and the call id are never arguments. end_call is ours: it hangs up after the goodbye.

const id = { type: 'string', description: 'An id from the facts or from an earlier tool result.' };
const language = { type: 'string', description: "The caller's language code, e.g. en or es." };

export const CORE_TOOLS = [
  {
    name: 'check_availability',
    description: 'Free start times for one barber, a list of services and one day (salon time). Offer at most three.',
    parameters: {
      type: 'object',
      properties: {
        staff_id: id,
        service_ids: { type: 'array', items: id },
        date: { type: 'string', description: 'YYYY-MM-DD, in the salon calendar.' },
        time_window: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'], description: 'Ask the caller: morning (before 12 PM), afternoon (12 to 5 PM) or evening (from 5 PM). any if they do not mind.' },
        earliest_time: { type: 'string', description: 'Optional HH:MM, salon time.' },
        language,
      },
      required: ['staff_id', 'service_ids', 'date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Books the slot after the caller clearly said yes to the read-back. Only say it is booked if ok is true.',
    parameters: {
      type: 'object',
      properties: {
        staff_id: id,
        service_ids: { type: 'array', items: id },
        start_iso: { type: 'string', description: 'start_iso exactly as check_availability returned it.' },
        customer_name: { type: 'string' },
        language,
        whatsapp_consent: { type: 'string', enum: ['true', 'false', 'unknown'], description: 'The caller agreed to WhatsApp reminders (a clear yes), said no, or was not asked.' },
      },
      required: ['staff_id', 'service_ids', 'start_iso', 'customer_name', 'language'],
    },
  },
  { name: 'find_my_appointments', description: "The caller's own upcoming appointments (matched by the number they are calling from).", parameters: null },
  {
    name: 'cancel_appointment',
    description: "Cancels one of the caller's own appointments after they confirmed which one.",
    parameters: { type: 'object', properties: { appointment_id: id }, required: ['appointment_id'] },
  },
  {
    name: 'reschedule_appointment',
    description: "Moves one of the caller's own appointments to a new start time from check_availability, after a read-back.",
    parameters: { type: 'object', properties: { appointment_id: id, new_start_iso: { type: 'string' } }, required: ['appointment_id', 'new_start_iso'] },
  },
  {
    name: 'previous_visit_reminder',
    description: 'Call once, right after the opening. Say its spoken sentence only if remind is true.',
    parameters: { type: 'object', properties: { language } },
  },
  {
    name: 'take_message',
    description: 'Leaves a message for the salon. Use it whenever you cannot help, nobody can take a transfer, or a tool fails.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What the caller wants the salon to know, in a few sentences.' },
        caller_name: { type: 'string' },
        callback_number: { type: 'string', description: 'Only if the caller gives a different number than the one they call from.' },
        reason: { type: 'string', enum: ['caller_request', 'no_transfer', 'after_hours', 'system_error'] },
        language,
      },
      required: ['message'],
    },
  },
  {
    name: 'transfer_to_human',
    description: 'Asks whether a person can take this call now. If ok, tell the caller you are connecting them now (the call moves by itself); otherwise take a message.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  },
] as const;

export const LOCAL_TOOLS = [
  { name: 'set_caller_language', description: 'Records the language the caller is currently speaking before any booking or appointment action. Call at call start and whenever the caller switches.', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['en', 'es', 'fa-IR', 'ar'] } }, required: ['language'] } },
  { name: 'end_call', description: 'Hangs up, after you said goodbye and the caller has nothing else.', parameters: null },
] as const;

/** Gemini's schema types are upper case (STRING, OBJECT, ...); a tool without arguments has no parameters. */
function geminiSchema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as object).map(([n, x]) => [n, geminiSchema(x)]));
    else if (k === 'items') out.items = geminiSchema(v);
    else out[k] = v;
  }
  return out;
}

export function geminiTools() {
  return [{
    functionDeclarations: [...CORE_TOOLS, ...LOCAL_TOOLS].map((t) => ({
      name: t.name, description: t.description,
      ...(t.parameters && Object.keys((t.parameters as any).properties ?? {}).length ? { parameters: geminiSchema(t.parameters) } : {}),
    })),
  }];
}

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set(CORE_TOOLS.map((t) => t.name));
