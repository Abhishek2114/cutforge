import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useStore } from './store'
import {
  ASPECTS, FLICKS, FRAME, addAsset, clips, move, newDoc, rippleDelete, seq, setAspect, setFit, split, totalDuration, trim,
  type Aspect, type Asset, type Doc, type Fit,
} from './model'
import { Player } from './player'
import { sniff } from './sniff'
import { clearAll, loadDoc, loadFile, saveDoc, saveFile } from './persist'
import { STR, type Lang } from './strings'

const player = new Player()
let restored = false // StrictMode runs effects twice in dev; restore media once
const newId = () => crypto.randomUUID()
const fmt = (t: number) => {
  const s = Math.max(0, t) / FLICKS
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 30)).padStart(2, '0')}`
}
const initialLang = (): Lang => {
  try {
    const saved = localStorage.getItem('cutforge:lang')
    if (saved === 'hi' || saved === 'en') return saved
  } catch { /* ignore */ }
  return navigator.language.startsWith('hi') ? 'hi' : 'en'
}

type Drag = { id: string; edge: 'in' | 'out'; x0: number; dx: number }

export function App() {
  const doc = useStore((s) => s.doc)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const [lang, setLang] = useState<Lang>(initialLang)
  const s = STR[lang]
  const [selected, setSelected] = useState<string | null>(null)
  const [px, setPx] = useState(60) // timeline pixels per second
  const [status, setStatus] = useState('')
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<Drag | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pxRef = useRef(px)
  pxRef.current = px

  const sq = seq(doc)
  const list = clips(doc)
  const total = totalDuration(doc)
  const sel = selected ? sq.items[selected] : undefined
  const { width: W, height: H } = sq.settings
  const k = 960 / Math.max(W, H)

  const current = () => useStore.getState().doc
  const act = (label: string, fn: (d: Doc) => void) => {
    if (useStore.getState().run(label, fn)) setStatus(label)
  }
  const seekTo = (t: number) => player.seek(t, current())
  const togglePlay = () => (player.playing ? player.pause() : player.play(current()))
  const doSplit = () => act(s.splitDone, (d) => split(d, player.t, newId()))
  const doDelete = () => {
    if (!selected) return
    act(s.deleted, (d) => rippleDelete(d, selected))
    setSelected(null)
  }
  const doUndo = () => {
    const l = useStore.getState().undo()
    if (l) setStatus(`${s.undone}: ${l}`)
  }
  const doRedo = () => {
    const l = useStore.getState().redo()
    if (l) setStatus(`${s.redone}: ${l}`)
  }

  async function addFiles(files: Iterable<File>) {
    for (const f of files) {
      if (!(await sniff(f))) {
        setStatus(`${f.name}: ${s.badFile}`)
        continue
      }
      const id = newId()
      try {
        const v = await player.add(id, f)
        const a: Asset = {
          id, kind: 'video', name: f.name.slice(0, 255), localRef: `opfs:${id}`, sizeBytes: f.size,
          duration: Math.max(1, Math.round(v.duration * FLICKS)),
          // shortcut: browsers don't expose fps/colour tags; server ingest (ffprobe) fills real values.
          video: {
            width: v.videoWidth, height: v.videoHeight, fps: { num: 30, den: 1 }, rotation: 0,
            color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' },
          },
        }
        act(s.added, (d) => addAsset(d, a, newId()))
        saveFile(id, f).catch(() => setStatus(s.mediaNotSaved))
      } catch {
        setStatus(`${f.name}: ${s.cantDecode}`)
      }
    }
  }

  async function doExport() {
    const d = current()
    setProgress(0)
    try {
      const { blob, ext } = await player.export(d, (p) => setProgress(Math.floor(p * 100)))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${d.name}.${ext}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      setStatus(s.exported)
    } catch {
      setStatus(s.exportFailed)
    } finally {
      setProgress(null)
    }
  }

  function newProject() {
    if (!confirm(s.confirmNew)) return
    const ids = Object.keys(current().assets)
    player.clear()
    void clearAll(ids)
    useStore.getState().reset(newDoc())
    setSelected(null)
    setMissing(new Set())
  }

  // Restore the last session (crash recovery).
  useEffect(() => {
    if (restored) return
    restored = true
    const saved = loadDoc()
    if (!saved || saved.schemaVersion !== 1) return
    useStore.getState().reset(saved)
    if (Object.keys(saved.assets).length) setStatus(STR[initialLang()].restored)
    for (const a of Object.values(saved.assets)) {
      loadFile(a.id)
        .then((f) => player.add(a.id, f))
        .catch(() => setMissing((m) => new Set(m).add(a.id)))
    }
  }, [])

  useEffect(() => saveDoc(doc), [doc]) // autosave every edit

  useEffect(() => {
    document.documentElement.lang = lang
    try { localStorage.setItem('cutforge:lang', lang) } catch { /* ignore */ }
  }, [lang])

  // Render loop: playhead and time are written to the DOM directly, so React never re-renders per frame.
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const d = current()
      player.tick(d)
      const cv = canvasRef.current
      if (cv) player.draw(cv.getContext('2d')!, cv.width, cv.height, d)
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${(player.t / FLICKS) * pxRef.current}px)`
      if (timeRef.current) timeRef.current.textContent = fmt(player.t)
      setPlaying(player.playing)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [])

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const target = e.target as HTMLElement
    if (target.closest('input, select, textarea')) return
    const key = e.key.toLowerCase()
    if (e.metaKey || e.ctrlKey) {
      if (key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo() }
      if (key === 'y') { e.preventDefault(); doRedo() }
      return
    }
    if ((key === ' ' || key === 'enter') && target.closest('button')) return // let the focused button act
    const step = e.shiftKey ? FLICKS : FRAME
    if (key === ' ') { e.preventDefault(); togglePlay() }
    else if (key === 'k') player.pause()
    else if (key === 'l') player.play(current())
    else if (key === 'j') seekTo(player.t - FLICKS)
    else if (key === 's') doSplit()
    else if (key === 'delete' || key === 'backspace') doDelete()
    else if ((key === 'arrowleft' || key === 'arrowright') && e.altKey && selected) {
      e.preventDefault()
      const dir = key === 'arrowleft' ? -1 : 1
      act(s.trimmed, (d) => trim(d, selected, e.shiftKey ? 'in' : 'out', dir * FRAME))
    } else if (key === 'arrowleft') { e.preventDefault(); seekTo(player.t - step) }
    else if (key === 'arrowright') { e.preventDefault(); seekTo(player.t + step) }
    else if (key === '+' || key === '=') setPx((p) => Math.min(400, p * 1.5))
    else if (key === '-') setPx((p) => Math.max(10, p / 1.5))
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const seekFromPointer = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    seekTo(((e.clientX - r.left) / px) * FLICKS)
  }
  const startTrim = (id: string, edge: 'in' | 'out') => (e: RPointerEvent) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setSelected(id)
    setDrag({ id, edge, x0: e.clientX, dx: 0 })
  }
  const moveTrim = (e: RPointerEvent) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0 })
  const endTrim = () => {
    if (!drag) return
    const delta = Math.round(((drag.dx / px) * FLICKS) / FRAME) * FRAME
    act(s.trimmed, (d) => trim(d, drag.id, drag.edge, delta))
    setDrag(null)
  }

  return (
    <div className="app">
      <header>
        <strong className="brand">CutForge</strong>
        <div role="group" aria-label={s.ratio} className="seg">
          {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
            <button key={a} aria-pressed={sq.settings.aspect === a} onClick={() => act(`${s.ratio} ${a}`, (d) => setAspect(d, a))}>
              {a}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button onClick={doUndo} disabled={!canUndo}>{s.undo}</button>
        <button onClick={doRedo} disabled={!canRedo}>{s.redo}</button>
        <button className="primary" onClick={() => void doExport()} disabled={!total || progress !== null}>
          {progress === null ? s.export : `${s.exporting} ${progress}%`}
        </button>
        <button onClick={newProject}>{s.newProject}</button>
        <button onClick={() => setLang(lang === 'hi' ? 'en' : 'hi')} lang={lang === 'hi' ? 'en' : 'hi'}>{s.langToggle}</button>
      </header>

      <main
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void addFiles(e.dataTransfer.files)
        }}
      >
        <section className="stage">
          {list.length === 0 && (
            <button className="dropzone" onClick={() => fileRef.current?.click()}>{s.drop}</button>
          )}
          <canvas ref={canvasRef} width={Math.round(W * k)} height={Math.round(H * k)} aria-label={s.preview} hidden={list.length === 0} />
        </section>

        <div className="controls">
          <button onClick={togglePlay} disabled={!total}>{playing ? s.pause : s.play}</button>
          <span className="time"><span ref={timeRef}>0:00.00</span> / {fmt(total)}</span>
          <button onClick={doSplit} disabled={!total}>{s.split}</button>
          <button onClick={doDelete} disabled={!sel}>{s.del}</button>
          {sel && list.length > 1 && (
            <>
              <button onClick={() => act(s.moved, (d) => move(d, sel.id, -1))} disabled={sel.start === 0}>{s.moveEarlier}</button>
              <button onClick={() => act(s.moved, (d) => move(d, sel.id, 1))} disabled={sel.start + sel.duration >= total}>{s.moveLater}</button>
            </>
          )}
          {sel && (
            <div role="group" aria-label={s.fitMode} className="seg">
              {(['fit', 'fill', 'blur'] as Fit[]).map((f) => (
                <button key={f} aria-pressed={sel.fit === f} onClick={() => act(`${s.fitMode}: ${s[f]}`, (d) => setFit(d, sel.id, f))}>
                  {s[f]}
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          <button onClick={() => fileRef.current?.click()}>{s.add}</button>
          <label className="zoom">
            {s.zoom}
            <input type="range" min={10} max={400} value={px} onChange={(e) => setPx(+e.target.value)} />
          </label>
        </div>

        <div className="timeline" role="group" aria-label={s.timeline}>
          <div
            className="track"
            style={{ width: (total / FLICKS) * px + 240 }}
            onPointerDown={seekFromPointer}
            onPointerMove={(e) => { if (e.buttons === 1 && !drag) seekFromPointer(e) }}
          >
            {list.map((c) => {
              let left = (c.start / FLICKS) * px
              let width = (c.duration / FLICKS) * px
              if (drag?.id === c.id) {
                if (drag.edge === 'in') { left += drag.dx; width -= drag.dx } else width += drag.dx
              }
              const name = doc.assets[c.assetId]?.name ?? ''
              const gone = missing.has(c.assetId)
              return (
                <div key={c.id} className={`clip${selected === c.id ? ' sel' : ''}${gone ? ' missing' : ''}`} style={{ left, width: Math.max(4, width) }}>
                  <button
                    className="clip-body"
                    aria-pressed={selected === c.id}
                    aria-label={`${name}, ${(c.duration / FLICKS).toFixed(1)} ${s.seconds}`}
                    onClick={() => setSelected(c.id)}
                  >
                    {gone ? `⚠ ${s.missing}` : name}
                  </button>
                  <span className="handle in" onPointerDown={startTrim(c.id, 'in')} onPointerMove={moveTrim} onPointerUp={endTrim} />
                  <span className="handle out" onPointerDown={startTrim(c.id, 'out')} onPointerMove={moveTrim} onPointerUp={endTrim} />
                </div>
              )
            })}
            <div className="playhead" ref={playheadRef} />
          </div>
        </div>

        <p className="status" aria-live="polite">{status}</p>
        <p className="hint">{s.hint}</p>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
          onChange={(e) => {
            if (e.target.files) void addFiles(Array.from(e.target.files))
            e.target.value = ''
          }}
        />
      </main>
    </div>
  )
}
