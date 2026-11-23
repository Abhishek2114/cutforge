import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Records a real video (with audio) inside the browser and returns its bytes.
async function makeVideo(page: Page, label: string, w: number, h: number, secs: number, color: string) {
  const b64 = await page.evaluate(async ([label, w, h, secs, color]) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    const ac = new AudioContext()
    const osc = ac.createOscillator()
    const dst = ac.createMediaStreamDestination()
    osc.connect(dst)
    osc.start()
    const rec = new MediaRecorder(new MediaStream([...c.captureStream(30).getVideoTracks(), ...dst.stream.getAudioTracks()]), { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    const stopped = new Promise((r) => (rec.onstop = r))
    rec.start()
    const t0 = performance.now()
    await new Promise<void>((done) => {
      const f = () => {
        g.fillStyle = color
        g.fillRect(0, 0, w, h)
        g.fillStyle = '#fff'
        g.font = 'bold 64px sans-serif'
        g.fillText(label, 20, 90)
        if ((performance.now() - t0) / 1000 < secs) requestAnimationFrame(f)
        else done()
      }
      f()
    })
    rec.stop()
    await stopped
    osc.stop()
    await ac.close()
    const u = new Uint8Array(await new Blob(chunks).arrayBuffer())
    let s = ''
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
    return btoa(s)
  }, [label, w, h, secs, color] as const)
  return Buffer.from(b64, 'base64')
}

// Duration, size and the centre colour at given times of a video file, measured in the browser.
async function probe(page: Page, bytes: Buffer, times: number[]) {
  return page.evaluate(async ([b64, times]) => {
    const u = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    const v = document.createElement('video')
    v.muted = true
    v.src = URL.createObjectURL(new Blob([u]))
    await new Promise((r) => (v.onloadedmetadata = r))
    if (v.duration === Infinity) {
      v.currentTime = 1e101
      await new Promise((r) => (v.ontimeupdate = r))
    }
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const g = c.getContext('2d')!
    const colours: string[] = []
    for (const t of times) {
      v.currentTime = t
      await new Promise((r) => (v.onseeked = r))
      g.drawImage(v, 0, 0)
      const [r, , b] = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data
      colours.push(r > b ? 'red' : 'blue')
    }
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, colours }
  }, [bytes.toString('base64'), times] as const)
}

// Clips in timeline order, read from their accessible labels ("A.webm, 2.9 seconds").
const timeline = async (page: Page) => {
  const labels = await page.locator('.clip-body').evaluateAll((els) =>
    els.map((e) => ({ x: (e.parentElement as HTMLElement).offsetLeft, label: e.getAttribute('aria-label')! })))
  return labels.sort((a, b) => a.x - b.x).map(({ label }) => {
    const [, name, secs] = label.match(/^(.*), ([\d.]+) seconds$/)!
    return { name, secs: +secs }
  })
}
const names = async (page: Page) => (await timeline(page)).map((c) => c.name)

test('every control in the editor works', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const btn = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' })

  await page.goto('./')
  await expect(page).toHaveTitle('CutForge')
  // Force English so the test reads the same in any locale.
  if (await btn('English').isVisible()) await btn('English').click()

  const A = await makeVideo(page, 'A', 640, 360, 3, '#d00000') // landscape, red
  const B = await makeVideo(page, 'B', 360, 640, 2, '#0040e0') // portrait, blue

  await test.step('drop zone opens the file picker and imports a video', async () => {
    const chooser = page.waitForEvent('filechooser')
    await btn(/Drop one or more videos/).click()
    await (await chooser).setFiles({ name: 'A.webm', mimeType: 'video/webm', buffer: A })
    await expect(page.locator('.clip')).toHaveCount(1)
    await expect(page.locator('canvas')).toBeVisible()
  })

  await test.step('"Add video" appends a second video (merge)', async () => {
    const chooser = page.waitForEvent('filechooser')
    await btn('Add video').click()
    await (await chooser).setFiles({ name: 'B.webm', mimeType: 'video/webm', buffer: B })
    await expect(page.locator('.clip')).toHaveCount(2)
    const [a, b] = await timeline(page)
    expect([a.name, b.name]).toEqual(['A.webm', 'B.webm'])
    expect(a.secs).toBeGreaterThan(2.5) // recorded ~3 s
    expect(b.secs).toBeGreaterThan(1.5) // recorded ~2 s
  })

  await test.step('rejects a non-video file whatever its name', async () => {
    const chooser = page.waitForEvent('filechooser')
    await btn('Add video').click()
    await (await chooser).setFiles({ name: 'fake.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(20).fill(0)]) })
    await expect(page.locator('.status')).toContainText('fake.mp4: not a supported video file')
    await expect(page.locator('.clip')).toHaveCount(2)
  })

  await test.step('Play advances time, Pause stops it', async () => {
    await btn('Play').click()
    await expect(btn('Pause')).toBeVisible()
    await expect.poll(() => page.locator('.time > span').textContent(), { timeout: 5000 }).not.toBe('0:00.00')
    await btn('Pause').click()
    await expect(btn('Play')).toBeVisible()
    const t = await page.locator('.time > span').textContent()
    await page.waitForTimeout(400)
    expect(await page.locator('.time > span').textContent()).toBe(t)
  })

  await test.step('clicking the timeline seeks and selects', async () => {
    await page.locator('.track').click({ position: { x: 60, y: 36 } }) // 60 px/s → 1.0 s, on clip A
    await expect(page.locator('.time > span')).toHaveText('0:01.00')
    await expect(page.locator('.clip.sel')).toHaveCount(1)
  })

  await test.step('Split, Delete, Undo, Redo buttons', async () => {
    const [a] = await timeline(page)
    await btn('Split (S)').click()
    const split = await timeline(page)
    expect(split.map((c) => c.name)).toEqual(['A.webm', 'A.webm', 'B.webm'])
    expect(split[0].secs).toBe(1)
    expect(split[1].secs).toBeCloseTo(a.secs - 1, 1)
    await btn('Delete (Del)').click() // deletes the selected first half
    expect(await timeline(page)).toEqual([split[1], split[2]])
    await btn('Undo').click()
    await expect(page.locator('.clip')).toHaveCount(3)
    await btn('Redo').click()
    await expect(page.locator('.clip')).toHaveCount(2)
  })

  await test.step('keyboard: S split, Ctrl+Z / Ctrl+Shift+Z, arrows, Space', async () => {
    await page.locator('.time').click() // focus something that is not a button
    await page.keyboard.press('Shift+ArrowLeft') // 1 s back → start
    await expect(page.locator('.time > span')).toHaveText('0:00.00')
    await page.keyboard.press('Shift+ArrowRight') // 1 s forward: well inside the first clip
    await expect(page.locator('.time > span')).toHaveText('0:01.00')
    await page.keyboard.press('s')
    await expect(page.locator('.clip')).toHaveCount(3)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.clip')).toHaveCount(2)
    await page.keyboard.press('Control+Shift+z')
    await expect(page.locator('.clip')).toHaveCount(3)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.time > span')).toHaveText('0:01.01') // one frame
    await page.keyboard.press(' ')
    await expect(btn('Pause')).toBeVisible()
    await page.keyboard.press('k')
    await expect(btn('Play')).toBeVisible()
  })

  await test.step('Move earlier / Move later reorder clips', async () => {
    await page.locator('.clip-body', { hasText: 'B.webm' }).click()
    await btn('◀ Move earlier').click()
    expect(await names(page)).toEqual(['B.webm', 'A.webm'])
    await btn('Move later ▶').click()
    expect(await names(page)).toEqual(['A.webm', 'B.webm'])
    await btn('◀ Move earlier').click() // final order for export: B then A
  })

  await test.step('every ratio button resizes the frame', async () => {
    for (const [name, w, h] of [['9:16', 9, 16], ['1:1', 1, 1], ['4:5', 4, 5], ['21:9', 2560, 1080], ['16:9', 16, 9]] as const) {
      await btn(name).click()
      await expect(btn(name)).toHaveAttribute('aria-pressed', 'true')
      const [cw, ch] = await page.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height])
      expect(Math.abs(cw / ch - w / h)).toBeLessThan(0.02)
    }
  })

  await test.step('Fit / Fill / Blur background framing buttons', async () => {
    await page.locator('.clip-body', { hasText: 'B.webm' }).click()
    for (const name of ['Fill', 'Blur background', 'Fit']) {
      await btn(name).click()
      await expect(btn(name)).toHaveAttribute('aria-pressed', 'true')
    }
    await btn('Blur background').click()
  })

  await test.step('dragging a clip edge trims it', async () => {
    const before = (await timeline(page)).find((c) => c.name === 'A.webm')!.secs
    const handle = page.locator('.clip', { hasText: 'A.webm' }).locator('.handle.out')
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 5 }) // 30 px = 0.5 s
    await page.mouse.up()
    await expect.poll(async () => (await timeline(page)).find((c) => c.name === 'A.webm')!.secs).toBeCloseTo(before - 0.5, 1)
  })

  await test.step('zoom slider and +/- keys change the timeline scale', async () => {
    const width = () => page.locator('.clip').first().evaluate((e) => e.getBoundingClientRect().width)
    const w0 = await width()
    await page.getByRole('slider').focus()
    await page.keyboard.press('PageUp')
    expect(await width()).toBeGreaterThan(w0)
    await page.locator('.time').click()
    await page.keyboard.press('-')
    await page.keyboard.press('-')
    expect(await width()).toBeLessThan(w0 * 1.2)
  })

  await test.step('Export merges the clips into one playable file', async () => {
    await btn('9:16').click()
    const [b, a] = await timeline(page)
    const download = page.waitForEvent('download', { timeout: 60_000 })
    await btn('Export').click()
    await expect(btn(/^Exporting…/)).toBeVisible()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^Untitled\.(mp4|webm)$/)
    await expect(page.locator('.status')).toHaveText('Export finished — file downloaded')
    const bytes = readFileSync((await file.path())!)
    const v = await probe(page, bytes, [b.secs / 2, b.secs + a.secs / 2])
    expect([v.width, v.height]).toEqual([1080, 1920])
    expect(Math.abs(v.duration - (a.secs + b.secs))).toBeLessThan(0.35)
    expect(v.colours).toEqual(['blue', 'red']) // B first, then A: merged in timeline order
  })

  await test.step('reload restores the project and its media', async () => {
    await page.reload()
    await expect(page.locator('.status')).toHaveText('Project restored')
    await expect(page.locator('.clip')).toHaveCount(2)
    await expect(page.locator('.clip.missing')).toHaveCount(0)
    await expect(btn('9:16')).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('Hindi / English toggle', async () => {
    await btn('हिन्दी').click()
    await expect(btn('चलाएँ')).toBeVisible()
    await expect(btn('एक्सपोर्ट करें')).toBeVisible()
    await btn('English').click()
    await expect(btn('Play')).toBeVisible()
  })

  await test.step('New project asks first, then clears', async () => {
    page.once('dialog', (d) => d.dismiss())
    await btn('New project').click()
    await expect(page.locator('.clip')).toHaveCount(2) // cancelled: nothing lost
    page.once('dialog', (d) => d.accept())
    await btn('New project').click()
    await expect(page.locator('.clip')).toHaveCount(0)
    await expect(btn(/Drop one or more videos/)).toBeVisible()
  })

  expect(errors).toEqual([])
})
