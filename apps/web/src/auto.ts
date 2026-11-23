// Auto edit: decisions made from the media itself, in the viewer's browser (no server, no API key).
// shortcut: silence detection is adaptive loudness, not a neural VAD; noisy rooms need Silero VAD (architecture §7).
import type { Correction, Fit } from './model'

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

/** Pauses in seconds, already shrunk by `pad` so speech keeps a natural breath. [] when there is no clear speech/pause contrast. */
export function findSilences(x: Float32Array, rate: number, minSilence = 0.5, pad = 0.1): [number, number][] {
  const win = Math.round(rate * 0.02) // 20 ms frames
  const n = Math.floor(x.length / win)
  if (n < 10) return []
  const db = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * win; j < (i + 1) * win; j++) sum += x[j] * x[j]
    db[i] = 10 * Math.log10(sum / win + 1e-12)
  }
  const sorted = Float32Array.from(db).sort()
  const floor = sorted[Math.floor(n * 0.1)], loud = sorted[Math.floor(n * 0.9)]
  if (loud - floor < 12) return [] // music, constant noise or silence throughout: cutting would harm it
  const threshold = floor + (loud - floor) * 0.3 // adapts to each recording's own noise floor
  const step = win / rate, end = x.length / rate
  const out: [number, number][] = []
  for (let i = 0; i < n; ) {
    if (db[i] >= threshold) { i++; continue }
    let j = i
    while (j < n && db[j] < threshold) j++
    if ((j - i) * step >= minSilence) {
      const a = i === 0 ? 0 : i * step + pad // leading/trailing dead air goes entirely
      const b = j === n ? end : j * step - pad
      if (b - a > 0.05) out.push([a, b])
    }
    i = j
  }
  return out
}

/** Colour fix from frame statistics (sRGB 0..1): aim for mid exposure and healthy contrast; gentle limits. */
export function autoCorrection({ mean, std, sat }: { mean: number; std: number; sat: number }): Correction {
  const r2 = (v: number) => Math.round(v * 100) / 100
  if (mean < 0.02) return { exposure: 0, contrast: 1, saturation: 1 } // black frames: nothing to learn
  return {
    exposure: r2(clamp(Math.log2(0.45 / mean), -1, 1)),
    contrast: r2(clamp(0.2 / Math.max(std, 0.01), 0.85, 1.3)),
    saturation: sat < 0.25 ? 1.15 : 1,
  }
}

/** Fill when the crop would be small, otherwise keep the whole picture over a blurred copy. */
export function framingFor(vw: number, vh: number, W: number, H: number): Fit {
  const r = vw / vh / (W / H)
  return r > 0.8 && r < 1.25 ? 'fill' : 'blur'
}

export const gradeFilter = (c?: Correction) =>
  c ? `brightness(${2 ** c.exposure}) contrast(${c.contrast}) saturate(${c.saturation})` : ''

// ── Browser-only measurement ──

export async function decodeAudio(url: string): Promise<{ samples: Float32Array; rate: number } | null> {
  try {
    const buf = await (await fetch(url)).arrayBuffer()
    const ab = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(buf) // resampled to 16 kHz
    const samples = ab.getChannelData(0).slice()
    for (let ch = 1; ch < ab.numberOfChannels; ch++) {
      const o = ab.getChannelData(ch)
      for (let i = 0; i < samples.length; i++) samples[i] += o[i]
    }
    if (ab.numberOfChannels > 1) for (let i = 0; i < samples.length; i++) samples[i] /= ab.numberOfChannels
    return { samples, rate: ab.sampleRate }
  } catch {
    return null // no audio track
  }
}

const once = (el: EventTarget, ev: string) => new Promise((r) => el.addEventListener(ev, r, { once: true }))

/** Mean luma, luma spread and mean saturation over 5 frames spread across [0, seconds]. */
export async function analyseFrames(url: string, seconds: number) {
  const v = document.createElement('video')
  v.muted = true
  v.src = url
  await once(v, 'loadeddata')
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 36
  const g = c.getContext('2d', { willReadFrequently: true })!
  let n = 0, sum = 0, sq = 0, satSum = 0
  for (let k = 1; k <= 5; k++) {
    v.currentTime = (seconds * k) / 6
    await once(v, 'seeked')
    g.drawImage(v, 0, 0, 64, 36)
    const p = g.getImageData(0, 0, 64, 36).data
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i] / 255, gr = p[i + 1] / 255, b = p[i + 2] / 255
      const y = 0.2126 * r + 0.7152 * gr + 0.0722 * b
      const max = Math.max(r, gr, b)
      sum += y
      sq += y * y
      satSum += max ? (max - Math.min(r, gr, b)) / max : 0
      n++
    }
  }
  v.removeAttribute('src')
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), sat: satSum / n }
}
