# Test calls after every change

Rules:
- One change (one PR) at a time. Merge it, wait until Cloud Run shows the new revision Ready, then make all four calls below.
- Call the test salon's number. No laptop speaker (it echoes); a phone, with or without its own speaker, is fine.
- All four pass: write the revision name (Cloud Run → Revisions, e.g. `barber-voice-live-00071-abc`) in "Known good" below.
- One fails: in Cloud Run → Revisions, send 100% of the traffic back to the last known good revision, then revert that PR.
- For a failure, keep the call text and the logs of that call (Logs, "Last 15 minutes", search `event`).

| # | What you say | Passes if |
|---|---|---|
| 1 | Nothing at all | The opening word for word; "How can I help you?" only twice in all; one goodbye; the line ends at once |
| 2 | "I'd like an appointment" → Erfan → haircut → tomorrow → the first time offered → WhatsApp: no | No question twice; free times offered without "morning or afternoon?"; full read-back and "is that right?"; **the booking is in the dashboard** with Erfan's own length; one goodbye |
| 3 | "I'd like an appointment" → Alireza → tomorrow at 10 (taken) | Alireza's other free times; Erfan (independent) is never offered |
| 4 | "I'd like an appointment" → Alireza → tomorrow → take none of the times → "leave a message" | Nothing more is asked; the message is in the dashboard (Messages); one goodbye |

## Languages

Each language is tested and locked on its own: the four calls above, spoken in that language (Persian
first, then English, then Spanish). A language is locked when all four pass in it; after any later
change, the four calls are run again in every locked language before it counts as good.

| Language | Test 1 silence | Test 2 booking | Test 3 taken time | Test 4 message | Locked (revision) |
|---|---|---|---|---|---|
| Persian (fa-IR) | ok (00085-vvb, 10-28) | | | | |
| English (en) | | | | | |
| Spanish (es) | | | | | |

Reset on 2026-10-28: call handling went back to revision 00064 (#54) and barber-core changed a lot
(kinds of business, rooms, 15 minutes), so every test is made again. Persian test 1 had passed before.

## Kinds of business

The call works the same for every kind of business; only the words and a few salon settings differ.
So the four calls above are made on the barbershop (in every language), and the kinds are checked once,
in English, on the same test salon switched to Massage for the time of these calls (Settings → Kind of
business), with: one room kind "Massage room" with one room, the service "Swedish massage 60 min" needing
it, every 15 minutes, "anyone free" on, one therapist a woman and one a man. Switch it back to Barbershop
afterwards.

| # | What you do | Passes if |
|---|---|---|
| M1 | Call, say nothing at first | The opening says "studio" (massage), and later the AI says "therapist", never "barber" |
| M2 | "A Swedish massage tomorrow, anyone is fine, a woman please" | Only the woman's times, each with her name; booked; in the dashboard the appointment has the room |
| M3 | Book the other therapist in the dashboard tomorrow at 10:00 (takes the only room); call for the woman at 10:00 | 10:00 is not offered (no room); other times are |
| M4 | Ask for something inappropriate; then "I'm pregnant, is that OK?" | A polite no and the call ends; no medical advice (tell the therapist at the visit) |

| Kinds of business | M1 | M2 | M3 | M4 | Locked (revision) |
|---|---|---|---|---|---|
| Massage (en) | | | | | |

## Known good

| Date | barber-voice-live revision | barber-core commit | Languages | Notes |
|---|---|---|---|---|
