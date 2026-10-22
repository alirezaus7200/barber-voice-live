// Phone audio <-> Gemini audio. Twilio streams 8 kHz G.711 mu-law; Gemini Live takes 16-bit PCM at
// 16 kHz and speaks 16-bit PCM at 24 kHz. Plain functions, no dependencies.

const BIAS = 0x84;
const CLIP = 32635;

export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const u = ~mulaw[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    out.writeInt16LE(sign ? -sample : sample, i * 2);
  }
  return out;
}

export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Linear resampling of 16-bit mono PCM (fine for speech on a phone line). */
export function resamplePcm16(input: Buffer, from: number, to: number): Buffer {
  if (from === to) return input;
  const n = Math.floor(input.length / 2);
  if (n === 0) return Buffer.alloc(0);
  const outN = Math.floor((n * to) / from);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * from) / to;
    const a = Math.min(Math.floor(pos), n - 1);
    const b = Math.min(a + 1, n - 1);
    const t = pos - a;
    out.writeInt16LE(Math.round(input.readInt16LE(a * 2) * (1 - t) + input.readInt16LE(b * 2) * t), i * 2);
  }
  return out;
}

/** Twilio's base64 mu-law 8 kHz -> base64 PCM 16 kHz for Gemini. */
export const phoneToGemini = (b64: string) => resamplePcm16(mulawToPcm16(Buffer.from(b64, 'base64')), 8000, 16000).toString('base64');

/** Gemini's base64 PCM (24 kHz unless the mime type says otherwise) -> base64 mu-law 8 kHz for Twilio. */
export function geminiToPhone(b64: string, mimeType = ''): string {
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000) || 24000;
  return pcm16ToMulaw(resamplePcm16(Buffer.from(b64, 'base64'), rate, 8000)).toString('base64');
}
