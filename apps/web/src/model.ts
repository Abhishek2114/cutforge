// Project document in the shape of packages/project-schema (schemaVersion 1) + pure edit commands.
// MVP: one sequence, one magnetic video track (clips always packed end to end).

export const FLICKS = 705_600_000 // per second
export const FPS = 30
export const FRAME = FLICKS / FPS

export type Fit = 'fit' | 'fill' | 'blur'
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | '21:9'
export const ASPECTS: Record<Aspect, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '21:9': [2560, 1080],
}

export interface Asset {
  id: string
  kind: 'video'
  name: string
  localRef: string
  sizeBytes: number
  duration: number
  video: {
    width: number
    height: number
    fps: { num: number; den: number }
    rotation: 0
    color: { primaries: 'bt709'; transfer: 'bt709'; matrix: 'bt709'; range: 'limited' }
  }
}

export interface Clip {
  id: string
  type: 'clip'
  trackId: 'v1'
  assetId: string
  start: number
  duration: number
  sourceIn: number
  fit: Fit
}

export interface Sequence {
  id: 's1'
  name: string
  settings: { aspect: Aspect; width: number; height: number; fps: { num: number; den: number }; sampleRate: 48000 }
  trackOrder: string[]
  tracks: Record<string, { id: string; kind: 'video'; name: string }>
  items: Record<string, Clip>
  transitions: Record<string, never>
  markers: Record<string, never>
}

export interface Doc {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  assets: Record<string, Asset>
  sequences: { s1: Sequence }
  activeSequenceId: 's1'
  captionSets: Record<string, never>
  cutSets: Record<string, never>
}

export function newDoc(now = new Date().toISOString()): Doc {
  return {
    schemaVersion: 1,
    id: 'local',
    name: 'Untitled',
    createdAt: now,
    updatedAt: now,
    assets: {},
    sequences: {
      s1: {
        id: 's1',
        name: 'Sequence 1',
        settings: { aspect: '16:9', width: 1920, height: 1080, fps: { num: FPS, den: 1 }, sampleRate: 48000 },
        trackOrder: ['v1'],
        tracks: { v1: { id: 'v1', kind: 'video', name: 'V1' } },
        items: {},
        transitions: {},
        markers: {},
      },
    },
    activeSequenceId: 's1',
    captionSets: {},
    cutSets: {},
  }
}

export const seq = (d: Doc) => d.sequences.s1
export const clips = (d: Doc) => Object.values(seq(d).items).sort((a, b) => a.start - b.start)
export const totalDuration = (d: Doc) => clips(d).reduce((t, c) => t + c.duration, 0)
export const clipAt = (d: Doc, t: number) => clips(d).find((c) => t >= c.start && t < c.start + c.duration)
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

function pack(d: Doc) {
  let t = 0
  for (const c of clips(d)) {
    c.start = t
    t += c.duration
  }
}

export function addAsset(d: Doc, a: Asset, clipId: string) {
  d.assets[a.id] = a
  seq(d).items[clipId] = {
    id: clipId, type: 'clip', trackId: 'v1', assetId: a.id,
    start: totalDuration(d), duration: a.duration, sourceIn: 0, fit: 'fit',
  }
}

export function split(d: Doc, t: number, newId: string) {
  const c = clipAt(d, t)
  if (!c) return
  const at = c.start + Math.round((t - c.start) / FRAME) * FRAME
  const end = c.start + c.duration
  if (at - c.start < FRAME || end - at < FRAME) return // both halves must keep at least one frame
  seq(d).items[newId] = { ...c, id: newId, start: at, duration: end - at, sourceIn: c.sourceIn + at - c.start }
  c.duration = at - c.start
}

export function trim(d: Doc, id: string, edge: 'in' | 'out', delta: number) {
  const c = seq(d).items[id]
  if (!c) return
  if (edge === 'in') {
    const dd = clamp(delta, -c.sourceIn, c.duration - FRAME)
    c.sourceIn += dd
    c.duration -= dd
  } else {
    c.duration = clamp(c.duration + delta, FRAME, d.assets[c.assetId].duration - c.sourceIn)
  }
  pack(d)
}

export function rippleDelete(d: Doc, id: string) {
  delete seq(d).items[id]
  pack(d)
}

export function setAspect(d: Doc, a: Aspect) {
  const s = seq(d).settings
  ;[s.width, s.height] = ASPECTS[a]
  s.aspect = a
}

export function setFit(d: Doc, id: string, fit: Fit) {
  const c = seq(d).items[id]
  if (c) c.fit = fit
}
