// The opening (AI disclosure + recording notice) as ready-made audio, word for word: Gemini Live may
// reword a sentence it is asked to repeat, so the opening is spoken once by Gemini's text-to-speech
// (the same voice) and played to the caller by us. Kept in memory per voice and text, so most calls
// pay nothing and start faster. The key stays in the environment, never in a URL or a log.
import { pcm16ToMulaw, resamplePcm16 } from './audio.ts';

export const TTS_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const MAX_CACHED = 200;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** PCM and its rate from Gemini's audio: raw L16 (rate in the mime type, else 24 kHz) or a WAV file. */
export function pcmOf(bytes: Buffer, mimeType: string): { pcm: Buffer; rate: number } {
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    let rate = 24000;
    for (let at = 12; at + 8 <= bytes.length;) {
      const id = bytes.toString('ascii', at, at + 4);
      const size = bytes.readUInt32LE(at + 4);
      if (id === 'fmt ') rate = bytes.readUInt32LE(at + 12);
      if (id === 'data') return { pcm: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)), rate };
      at += 8 + size + (size % 2);
    }
    return { pcm: Buffer.alloc(0), rate };
  }
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
  return { pcm: bytes, rate: rate > 0 ? rate : 24000 };
}

/** speak(text) -> the phone's audio (base64 mu-law 8 kHz), or null when it cannot be made. */
export function openingSpeaker(o: { apiKey: string; voice: string; model?: string; fetch?: FetchLike; log?: (e: string, d: Record<string, unknown>) => void }) {
  const cache = new Map<string, string>();
  const model = o.model || TTS_DEFAULT_MODEL;
  return async (text: string): Promise<string | null> => {
    const key = `${o.voice}\n${text}`;
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const res = await (o.fetch ?? (fetch as unknown as FetchLike))(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }], // the text alone: an instruction could be read out too
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } },
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      const data: any = await res.json().catch(() => ({}));
      const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
      if (!res.ok || !part) {
        o.log?.('opening_tts_failed', { status: res.status, error: String(data?.error?.message ?? 'no audio').split(o.apiKey).join('***').slice(0, 200) });
        return null;
      }
      const { pcm, rate } = pcmOf(Buffer.from(part.inlineData.data, 'base64'), String(part.inlineData.mimeType ?? ''));
      if (!pcm.length) return null;
      const audio = pcm16ToMulaw(resamplePcm16(pcm, rate, 8000)).toString('base64');
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
      cache.set(key, audio);
      return audio;
    } catch (e: any) {
      o.log?.('opening_tts_failed', { error: String(e?.name ?? e).slice(0, 60) });
      return null;
    }
  };
}
