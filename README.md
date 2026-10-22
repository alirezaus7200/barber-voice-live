# barber-voice-live

منشی تلفنی سالن‌ها با **Gemini Live** گوگل: خودش می‌شنود و حرف می‌زند، به هر زبانی، و مشتری می‌تواند
وسط تماس زبان را عوض کند (فارسی، انگلیسی، اسپانیایی، فرانسوی…). خط تلفن از **Twilio** است.

این پروژه **فقط صدا** است. همه‌چیزِ سالن‌ها (آرایشگرها، ساعت‌ها، نوبت‌ها، قانون‌ها، پیام‌ها، گزارش تماس)
در پروژه‌ی اصلی **barber-core** است و این سرور برای هر کاری از آن می‌پرسد، با همان امضای امنی که Vapi
استفاده می‌کند. پس قانون‌های نوبت‌دهی فقط یک جا هستند.

```
مشتری ──تلفن──> Twilio ──صدا (WebSocket)──> این سرور <──صدا──> Gemini Live
                                              │
                                              └── ابزارها، اطلاعات سالن، گزارش ──> barber-core
```

## وضعیت
- ✅ کد و تست‌ها (بدون اینترنت، با سوکت‌های ساختگی): صدا در دو جهت، ابزارها، انتقال تماس، جمله‌ی اول، پایان تماس.
- ⏳ هنوز روی سرور واقعی اجرا نشده و با تماس واقعی امتحان نشده. اسم دقیق مدل Gemini Live را از AI Studio برمی‌داریم.

## راه‌اندازی (خلاصه، بعداً قدم‌به‌قدم)
1. یک میزبان که WebSocket را در تمام تماس باز نگه دارد (مثلاً Google Cloud Run، Railway یا Fly.io). Vercel مناسب نیست.
2. متغیرهای `.env.example` را در تنظیمات میزبان بگذار (هرگز در کد یا گیت).
3. در Twilio یک شماره بخر و برای «A call comes in» آدرس `https://<این سرور>/twilio/voice` (POST) را بگذار.
4. در barber-core همان شماره را به سالن وصل کن (`scripts/add-phone-number.ts`، با `--provider twilio`).

## English
Phone calls for barber-core salons with Google Gemini Live (speech to speech, any language) over Twilio.
Bookings and rules stay in barber-core; this server calls its signed voice webhook. See CLAUDE.md.
`npm ci && npm run typecheck && npm test`.
