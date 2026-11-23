import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { produce } from 'immer'
import { FLICKS, FRAME, addAsset, clips, move, newDoc, rippleDelete, seq, setAspect, setFit, split, totalDuration, trim, type Asset, type Doc } from './model'
import { useStore } from './store'
import { sniff } from './sniff'

const asset = (id: string, seconds: number): Asset => ({
  id, kind: 'video', name: `${id}.mp4`, localRef: `opfs:${id}`, sizeBytes: 1000, duration: seconds * FLICKS,
  video: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, rotation: 0, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' } },
})
const edit = (d: Doc, fn: (d: Doc) => void) => produce(d, fn)
const twoClips = () => edit(newDoc('2026-11-23T00:00:00Z'), (d) => { addAsset(d, asset('a', 10), 'c1'); addAsset(d, asset('b', 5), 'c2') })
const shape = (d: Doc) => clips(d).map((c) => [c.id, c.start / FLICKS, c.duration / FLICKS, c.sourceIn / FLICKS])

describe('commands', () => {
  it('appends clips end to end', () => {
    expect(shape(twoClips())).toEqual([['c1', 0, 10, 0], ['c2', 10, 5, 0]])
  })

  it('splits at the playhead, keeping source continuity', () => {
    const d = edit(twoClips(), (d) => split(d, 4 * FLICKS, 'c1b'))
    expect(shape(d)).toEqual([['c1', 0, 4, 0], ['c1b', 4, 6, 4], ['c2', 10, 5, 0]])
  })

  it('refuses a split that would leave less than a frame', () => {
    const d = twoClips()
    expect(edit(d, (x) => split(x, FRAME / 4, 'z'))).toBe(d) // snaps to frame 0: nothing left of the cut
    expect(edit(d, (x) => split(x, 20 * FLICKS, 'z'))).toBe(d) // past the end
  })

  it('trims both edges within source bounds and closes gaps', () => {
    let d = edit(twoClips(), (d) => trim(d, 'c1', 'in', 2 * FLICKS))
    expect(shape(d)).toEqual([['c1', 0, 8, 2], ['c2', 8, 5, 0]])
    d = edit(d, (d) => trim(d, 'c1', 'in', -100 * FLICKS)) // cannot go before source start
    expect(shape(d)[0]).toEqual(['c1', 0, 10, 0])
    d = edit(d, (d) => trim(d, 'c2', 'out', 100 * FLICKS)) // cannot extend past source end
    expect(shape(d)[1]).toEqual(['c2', 10, 5, 0])
    d = edit(d, (d) => trim(d, 'c2', 'out', -100 * FLICKS)) // keeps at least one frame
    expect(clips(d)[1].duration).toBe(FRAME)
  })

  it('reorders clips for merging, ignoring moves past either end', () => {
    const d = edit(twoClips(), (d) => move(d, 'c2', -1))
    expect(shape(d)).toEqual([['c2', 0, 5, 0], ['c1', 5, 10, 0]])
    expect(edit(d, (x) => move(x, 'c2', -1))).toBe(d)
    expect(edit(d, (x) => move(x, 'c1', 1))).toBe(d)
  })

  it('ripple-deletes and closes the gap', () => {
    const d = edit(twoClips(), (d) => rippleDelete(d, 'c1'))
    expect(shape(d)).toEqual([['c2', 0, 5, 0]])
    expect(totalDuration(d)).toBe(5 * FLICKS)
  })

  it('changes ratio without touching the timeline', () => {
    const before = twoClips()
    const d = edit(before, (d) => setAspect(d, '9:16'))
    expect([seq(d).settings.width, seq(d).settings.height]).toEqual([1080, 1920])
    expect(seq(d).items).toBe(seq(before).items)
  })
})

describe('undo/redo', () => {
  it('round-trips every command', () => {
    const st = useStore.getState()
    st.reset(newDoc('2026-11-23T00:00:00Z'))
    const s0 = useStore.getState().doc
    st.run('add', (d) => addAsset(d, asset('a', 10), 'c1'))
    st.run('split', (d) => split(d, 3 * FLICKS, 'c2'))
    const s2 = useStore.getState().doc
    expect(st.run('noop split', (d) => split(d, 0, 'x'))).toBe(false) // no-ops don't pollute history
    expect(useStore.getState().undo()).toBe('split')
    expect(useStore.getState().undo()).toBe('add')
    expect(useStore.getState().doc).toEqual(s0)
    useStore.getState().redo()
    useStore.getState().redo()
    expect(useStore.getState().doc).toEqual(s2)
  })
})

describe('project file', () => {
  it('stays valid against packages/project-schema after editing', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../packages/project-schema/project.schema.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    const d = edit(twoClips(), (d) => { split(d, 4 * FLICKS, 'c3'); setAspect(d, '4:5'); setFit(d, 'c3', 'blur'); trim(d, 'c2', 'out', -FLICKS) })
    expect(validate(d), JSON.stringify(validate.errors, null, 1)).toBe(true)
  })
})

describe('sniff', () => {
  const bytes = (...b: number[]) => new Blob([new Uint8Array([...b, ...Array(12).fill(0)])])
  it('accepts MP4/MOV and WebM/MKV by magic bytes', async () => {
    expect(await sniff(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toBe('mp4')
    expect(await sniff(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('webm')
  })
  it('rejects other files whatever their name', async () => {
    expect(await sniff(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull() // PNG
    expect(await sniff(new Blob(['tiny']))).toBeNull()
  })
})
