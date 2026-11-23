import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { autoCorrection, findSilences, framingFor, gapsBetween } from './auto'
import { FLICKS, addAsset, clips, newDoc, removeRanges, type Asset } from './model'

const RATE = 16000
// Builds audio from [seconds, amplitude] pieces: a 220 Hz "voice" over a faint noise floor.
function signal(...pieces: [number, number][]) {
  const out = new Float32Array(pieces.reduce((n, [s]) => n + Math.round(s * RATE), 0))
  let i = 0
  let seed = 1
  for (const [s, amp] of pieces) {
    for (let k = 0; k < Math.round(s * RATE); k++, i++) {
      seed = (seed * 16807) % 2147483647
      out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.002 * (seed / 2147483647 - 0.5)
    }
  }
  return out
}
const round = (r: [number, number][]) => r.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)])

describe('findSilences', () => {
  it('finds a pause between speech and keeps 0.1 s of breath on each side', () => {
    expect(round(findSilences(signal([1, 0.3], [1, 0], [1, 0.3]), RATE))).toEqual([[1.1, 1.9]])
  })
  it('removes leading and trailing dead air completely', () => {
    expect(round(findSilences(signal([0.8, 0], [1, 0.3], [0.7, 0]), RATE))).toEqual([[0, 0.7], [1.9, 2.5]])
  })
  it('ignores pauses shorter than 0.5 s (natural pacing)', () => {
    expect(findSilences(signal([1, 0.3], [0.3, 0], [1, 0.3]), RATE)).toEqual([])
  })
  it('never cuts audio without speech/pause contrast (music, constant noise)', () => {
    expect(findSilences(signal([3, 0.3]), RATE)).toEqual([])
    expect(findSilences(signal([3, 0]), RATE)).toEqual([])
  })
})

describe('gapsBetween (pauses from the voice detector)', () => {
  it('turns gaps between speech into cuts with breathing room', () => {
    expect(round(gapsBetween([[0.5, 2], [3.2, 5]], 6))).toEqual([[0, 0.4], [2.1, 3.1], [5.1, 6]])
  })
  it('keeps short gaps (natural pacing) and overlapping segments', () => {
    expect(gapsBetween([[0, 2], [2.3, 4], [3.5, 5]], 5)).toEqual([])
  })
  it('cuts nothing when the detector hears almost no voice', () => {
    expect(gapsBetween([], 30)).toEqual([])
    expect(gapsBetween([[10, 11]], 30)).toEqual([]) // 3% speech: probably music or ambience
  })
})

describe('removeRanges', () => {
  const asset: Asset = {
    id: 'a', kind: 'video', name: 'a.mp4', localRef: 'opfs:a', sizeBytes: 1, duration: 10 * FLICKS,
    video: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, rotation: 0, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' } },
  }
  const base = produce(newDoc('2026-11-23T00:00:00Z'), (d) => addAsset(d, asset, 'c1'))
  const s = (x: number) => x * FLICKS
  let n = 0
  const ids = () => `n${++n}`

  it('cuts pauses out and closes the gaps', () => {
    const d = produce(base, (d) => removeRanges(d, 'c1', [[s(2), s(3)], [s(5), s(6)]], ids))
    expect(clips(d).map((c) => [c.start / FLICKS, c.duration / FLICKS, c.sourceIn / FLICKS])).toEqual([[0, 2, 0], [2, 2, 3], [4, 4, 6]])
  })
  it('handles cuts at the edges and overlapping cuts', () => {
    const d = produce(base, (d) => removeRanges(d, 'c1', [[0, s(1)], [s(4), s(6)], [s(5), s(7)], [s(9), s(12)]], ids))
    expect(clips(d).map((c) => [c.sourceIn / FLICKS, c.duration / FLICKS])).toEqual([[1, 3], [7, 2]])
  })
  it('leaves the clip untouched when nothing falls inside it', () => {
    expect(produce(base, (d) => removeRanges(d, 'c1', [[s(20), s(30)]], ids))).toBe(base)
  })
})

describe('autoCorrection and framingFor', () => {
  it('brightens dark footage within safe limits and leaves good footage alone', () => {
    expect(autoCorrection({ mean: 0.15, std: 0.1, sat: 0.1 })).toEqual({ exposure: 1, contrast: 1.3, saturation: 1.15 })
    expect(autoCorrection({ mean: 0.45, std: 0.2, sat: 0.4 })).toEqual({ exposure: 0, contrast: 1, saturation: 1 })
    expect(autoCorrection({ mean: 0, std: 0, sat: 0 })).toEqual({ exposure: 0, contrast: 1, saturation: 1 })
  })
  it('fills near-matching shapes and blurs mismatched ones', () => {
    expect(framingFor(1920, 1080, 1920, 1080)).toBe('fill')
    expect(framingFor(1080, 1350, 1080, 1920)).toBe('blur') // 4:5 in 9:16 would lose too much
    expect(framingFor(1920, 1080, 1080, 1920)).toBe('blur')
  })
})
