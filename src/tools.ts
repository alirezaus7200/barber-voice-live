// The tools Gemini may call. They are barber-core's tools (src/voice/vapi-tools.ts there: names,
// descriptions and arguments must stay the same; barber-core checks every argument again). The salon,
// the caller and the call id are never arguments. end_call is ours: it hangs up after the goodbye.

const id = { type: 'string', description: 'An id from the facts or from an earlier tool result.' };
const language = { type: 'string', description: "The caller's language code, e.g. en or es." };

export const CORE_TOOLS = [
  {
    name: 'check_availability',
    description: 'Free start times for one staff member, a list of services and one day (salon time). Offer at most three. If that day is full, the same answer gives the staff member\'s next free day with its times and the other staff members free that day: offer those at once, never day by day. With staff_id any, each time says whose it is: book with that staff_id.',
    parameters: {
      type: 'object',
      properties: {
        staff_id: { type: 'string', description: 'A staff id from the facts, or any when the caller wants anyone free and the booking rules allow it.' },
        staff_gender: { type: 'string', enum: ['woman', 'man'], description: 'Only with staff_id any: the caller asked for a woman or a man.' },
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
    name: 'find_services',
    description: 'Finds services by the words the caller used (e.g. "pedicure", "back massage"), in any language: ids, names, group, duration, price and who does each. Use it when the services are too many to be listed in the facts; never guess a service id.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the caller wants, in their words.' },
        language,
      },
      required: ['query'],
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
        customer_name: { type: 'string', description: "Always. A new caller: the name they said and confirmed, exactly. A known caller: the first name from Known caller (the name on file is kept). Never a guess or a made-up word." },
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
    description: 'The phone system calls this itself right after the opening; never call it.',
    parameters: { type: 'object', properties: { language } },
  },
  {
    name: 'set_caller_language',
    description: 'Call once as soon as you know the caller\'s language (from their first words, or after asking once), and again only if they clearly switch. how: chose = they said which language, detected = you heard it.',
    parameters: {
      type: 'object',
      properties: { language, how: { type: 'string', enum: ['chose', 'detected'] } },
      required: ['language'],
    },
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
    description: 'Asks whether a person can take this call now: the chosen staff member (staff_id) if the salon set a phone for them, else the salon. If ok, tell the caller you are connecting them now (the call moves by itself); otherwise take a message.',
    parameters: { type: 'object', properties: { reason: { type: 'string' }, staff_id: { type: 'string', description: 'The staff member the caller wants to talk to (staff_list id), if any.' } } },
  },
] as const;

export const LOCAL_TOOLS = [
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

// barber-core tools this server calls itself (the AI is not given them: it said "one moment" before them)
export const BRIDGE_ONLY_TOOLS: ReadonlySet<string> = new Set(['previous_visit_reminder']);

export function geminiTools() {
  return [{
    functionDeclarations: [...CORE_TOOLS, ...LOCAL_TOOLS].filter((t) => !BRIDGE_ONLY_TOOLS.has(t.name)).map((t) => ({
      name: t.name, description: t.description,
      ...(t.parameters && Object.keys((t.parameters as any).properties ?? {}).length ? { parameters: geminiSchema(t.parameters) } : {}),
    })),
  }];
}

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set(CORE_TOOLS.map((t) => t.name));
