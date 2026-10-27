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
| Persian (fa-IR) | ok | | | | |
| English (en) | | | | | |
| Spanish (es) | | | | | |

## Known good

| Date | barber-voice-live revision | barber-core commit | Languages | Notes |
|---|---|---|---|---|
