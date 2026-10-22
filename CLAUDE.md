# CLAUDE.md: barber-voice-live

The phone side of the barbershop AI receptionist with Google **Gemini Live** (speech to speech: it
hears and speaks every language, the caller may switch mid-call), over **Twilio**. It is only the
voice: everything about salons, bookings and rules lives in **barber-core** (alirezaus7200/barber-core).
Owner: Alireza (speaks Persian; explain in simple words, show exact commands).

## Hard rules
1. No booking rules here. Every salon fact and every tool runs in barber-core, through its signed
   voice webhook (`/api/webhooks/vapi`, the same message format the Vapi platform uses: assistant-request,
   tool-calls, end-of-call-report). `src/tools.ts` must match barber-core's `src/voice/vapi-tools.ts`.
2. The salon comes from the dialed number and the caller from caller ID, both from Twilio's signed
   request (`X-Twilio-Signature`), carried to the media socket with a short-lived stream token. Never
   from what the model or the caller says.
3. The opening (AI disclosure + recording notice) is barber-core's `firstMessage`, said first, word for word.
4. A transfer happens only when barber-core's `transfer_to_human` answers ok (salon open); the number is
   the salon's own, from barber-core.
5. No secrets in code, docs, tests or git: `.env` locally, the host's settings in production.

## Layout
```
src/server.ts   http (Twilio webhook) + WebSocket (Twilio media) server
src/session.ts  one call: Twilio audio <-> Gemini Live, tools via barber-core, transfer, end report
src/core.ts     barber-core client (HMAC-SHA256 of "<ts>.<body>", hex) and the prompt filler
src/twilio.ts   Twilio signature, TwiML, live-call update (transfer / notice / hang up), stream token
src/audio.ts    mu-law 8 kHz <-> PCM 16/24 kHz
src/tools.ts    Gemini function declarations (barber-core's tools + end_call)
src/prompt.txt  barber-core docs/receptionist_prompt.md section 2 (keep in step)
```

## Work
Node 22+, runtime dependency `ws` only. `npm run typecheck`, `npm test` (no network, fake sockets).
Small steps, tests first, one feature per branch.
