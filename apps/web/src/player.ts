import { FLICKS, FPS, clipAt, seq, totalDuration, type Doc, type Fit } from './model'
import { gradeFilter } from './auto'

// shortcut: Canvas 2D + <video> + MediaRecorder instead of the shared wgpu engine (architecture ADR-001);
// preview/export parity and faster-than-real-time export arrive with the engine.

export function drawFit(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number, fit: Fit, grade = '') {
  const vw = v.videoWidth, vh = v.videoHeight
  const draw = (k: number) => ctx.drawImage(v, (W - vw * k) / 2, (H - vh * k) / 2, vw * k, vh * k)
  const contain = Math.min(W / vw, H / vh), cover = Math.max(W / vw, H / vh)
  if (fit === 'blur') {
    ctx.filter = `blur(${Math.round(H * 0.03)}px) ${grade}` // radius relative to frame height: same look at any resolution
    draw(cover)
  }
  ctx.filter = grade || 'none'
  draw(fit === 'fill' ? cover : contain)
  ctx.filter = 'none'
}

const once = (el: EventTarget, ev: string) => new Promise((r) => el.addEventListener(ev, r, { once: true }))

export class Player {
  t = 0
  playing = false
  private media = new Map<string, HTMLVideoElement>()
  private ac?: AudioContext
  private out?: MediaStreamAudioDestinationNode

  async add(id: string, file: Blob): Promise<HTMLVideoElement> {
    const v = document.createElement('video')
    v.preload = 'auto'
    v.playsInline = true
    v.src = URL.createObjectURL(file)
    try {
      await new Promise<void>((ok, fail) => {
        v.onloadedmetadata = () => ok()
        v.onerror = () => fail(new Error('decode'))
      })
      if (v.duration === Infinity) {
        // WebM from MediaRecorder has no duration header; seeking far forces the browser to compute it.
        v.currentTime = 1e101
        await Promise.race([once(v, 'timeupdate'), new Promise((r) => setTimeout(r, 3000))])
        v.currentTime = 0
      }
      if (!v.videoWidth || !Number.isFinite(v.duration) || v.duration <= 0) throw new Error('no video track')
    } catch (e) {
      URL.revokeObjectURL(v.src)
      throw e
    }
    this.media.set(id, v)
    if (this.ac) this.wire(v)
    return v
  }

  clear() {
    this.pause()
    for (const v of this.media.values()) URL.revokeObjectURL(v.src)
    this.media.clear()
    this.t = 0
  }

  private wire(v: HTMLVideoElement) {
    const src = this.ac!.createMediaElementSource(v)
    src.connect(this.ac!.destination)
    src.connect(this.out!)
  }

  // Must first run inside a user gesture (browser autoplay rules).
  private audio() {
    if (!this.ac) {
      this.ac = new AudioContext()
      this.out = this.ac.createMediaStreamDestination()
      this.media.forEach((v) => this.wire(v))
    }
    void this.ac.resume()
    return this.out!
  }

  play(d: Doc) {
    const total = totalDuration(d)
    if (!total) return
    this.audio()
    if (this.t >= total - FLICKS / FPS) this.t = 0
    this.playing = true
  }

  pause() {
    this.playing = false
    this.media.forEach((v) => v.pause())
  }

  seek(t: number, d: Doc) {
    this.t = Math.min(Math.max(0, Math.round(t)), Math.max(0, totalDuration(d) - 1))
    this.media.forEach((v) => v.pause()) // next tick re-seeks the right element (and resumes if playing)
  }

  // Advance the playhead from the active video's clock; called every animation frame.
  tick(d: Doc) {
    const c = clipAt(d, this.t)
    if (!c) {
      if (this.playing) this.pause()
      return
    }
    const v = this.media.get(c.assetId)
    for (const o of this.media.values()) if (o !== v && !o.paused) o.pause()
    if (!v) {
      if (this.playing) this.t = c.start + c.duration // media missing: skip the clip
      return
    }
    if (v.seeking) return
    const want = (c.sourceIn + this.t - c.start) / FLICKS
    if (!this.playing) {
      if (Math.abs(v.currentTime - want) > 0.5 / FPS) v.currentTime = want
      return
    }
    if (v.paused) {
      v.currentTime = want
      v.play().catch(() => {}) // a play cut short by pause/seek is expected; the next tick retries
      return
    }
    const t = c.start + Math.round(v.currentTime * FLICKS) - c.sourceIn
    const end = c.start + c.duration
    if (t >= end) {
      v.pause()
      this.t = end
      if (end >= totalDuration(d)) this.pause()
    } else if (t > this.t) this.t = t
  }

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, d: Doc) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    const c = clipAt(d, Math.min(this.t, totalDuration(d) - 1))
    const v = c && this.media.get(c.assetId)
    if (c && v?.videoWidth) drawFit(ctx, v, W, H, c.fit, c.grade?.enabled ? gradeFilter(c.grade.correction) : '')
  }

  url(id: string) {
    return this.media.get(id)?.src
  }

  // shortcut: renders in real time and stalls if the tab is hidden; the engine export (D3) renders offline.
  async export(d: Doc, onProgress: (p: number) => void): Promise<{ blob: Blob; ext: string }> {
    const { width: W, height: H } = seq(d).settings
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const audio = this.audio()
    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...audio.stream.getAudioTracks()])
    const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m))
    if (!mime) throw new Error('no encoder')
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    const stopped = once(rec, 'stop')
    const total = totalDuration(d)
    this.seek(0, d)
    this.playing = true
    rec.start(1000)
    await new Promise<void>((done) => {
      const step = () => {
        this.tick(d)
        this.draw(ctx, W, H, d)
        onProgress(Math.min(1, this.t / total))
        if (this.playing) requestAnimationFrame(step)
        else done()
      }
      step()
    })
    rec.stop()
    await stopped
    return { blob: new Blob(chunks, { type: mime }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' }
  }
}
