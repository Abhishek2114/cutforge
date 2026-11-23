# CutForge — Architecture (Deliverable 1)

Status: **draft for approval** · 2026-11-23

Companion files:
- [data-model.sql](data-model.sql): Postgres schema
- [api.yaml](api.yaml): REST API (OpenAPI 3.1)
- [project.schema.json](../packages/project-schema/project.schema.json): project document (EDL) schema, with [examples](../packages/project-schema/examples/)

---

## 0. Decisions already taken

| Topic | Decision | Source |
|---|---|---|
| Hosting | AWS `ap-south-1` (Mumbai); GPU workers on spot instances that scale to zero | Q&A |
| Translation / transliteration | Self-hosted AI4Bharat **IndicTrans2** + **IndicXlit** on our GPU workers | Q&A |
| Collaboration | Single user per project; versioned saves; one active editor per project (edit lease) | Q&A |
| Desktop codecs | LGPL FFmpeg (no x264/x265) + OS/GPU hardware encoders; Cisco OpenH264 as fallback; GPL x264 only on our servers | Q&A |
| Auth | Phone OTP + Google sign-in, built into the API (no third-party auth vendor) | **Assumed** — please confirm |
| Payments | Razorpay (UPI Autopay for subscriptions) | **Assumed** |
| Desktop OS order | Windows + macOS first, Linux later (see risk R4) | **Assumed** |

---

## 1. The three bets that shape everything

### Bet 1: one compositor, everywhere (ADR-001)

The requirement "preview and export render identically" cannot be met by writing the pixel math twice (WebGL shaders for preview, an FFmpeg filtergraph for export). `eq`, `colorbalance`, `scale` and `overlay` will never match a hand-written shader to within a few LSB. Every new effect would then need two implementations and a permanent parity bug queue.

**Decision:** a single Rust crate, `cutforge-engine`, renders frames with **wgpu** and **WGSL** shaders. It runs in three places:

| Target | Build | GPU backend |
|---|---|---|
| Web preview + browser export | `wasm32` via wasm-bindgen, in a Web Worker on `OffscreenCanvas` | WebGPU, falling back to WebGL2 (wgpu translates WGSL to GLSL through naga) |
| Desktop preview + export | Linked into the Tauri Rust process | Metal / DX12 / Vulkan |
| Cloud export | `cutforge-render` CLI inside the export worker | Vulkan on GPU nodes; lavapipe (CPU) in CI |

**FFmpeg only demuxes, decodes, encodes and muxes. It never touches pixels.** The engine also owns the audio mixer, keyframe evaluation, the ASS subtitle generator and the grade-LUT baker, so every target runs the same code. The web UI (React/TS) never computes a pixel or a sample itself.

This does mean the team needs Rust skills (risk R2). The alternative, generating an FFmpeg filtergraph from the project, was rejected: it gives no parity with the preview, and keyframes, speed ramps, karaoke and blur-background are awkward or very slow as filtergraphs.

### Bet 2: time is an integer, captions are anchored to source time (ADR-002, ADR-004)

- All times are **integer flicks**: 1 s = 705,600,000 flicks. Every common frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120) and sample rate (8k–48k, 44.1k) is an exact integer number of flicks, so there is no float drift. JS integers stay safe up to about 147 days.
- Transcripts, caption segments, silence/filler regions and highlight ranges are stored in **source time of an asset**, not timeline time. The timeline position of a caption is computed at render time through the clip's `start / sourceIn / speed` mapping. **So trimming, cutting, splitting, ripple-deleting, changing speed or making a reel re-syncs subtitles for free**, because nothing needs to be rewritten. This is how the "subtitles stay in sync after silence cuts" requirement is met by construction rather than by fix-up code.

### Bet 3: the project is a JSON document; edits are patches (ADR-003)

- The project document (schema in `packages/project-schema`) is the single source of truth. Collections are **maps keyed by ID** (not arrays), so a patch path such as `/sequences/s1/items/c7/duration` stays valid when other items change.
- The Zustand store uses Immer. Each user action is a **command** that Immer turns into `{patches, inversePatches}` (RFC 6902-style). Undo applies the inverse patches, so history is unlimited, bounded only by memory, and kept in IndexedDB for the session.
- The same patches feed **autosave**: IndexedDB at once, the server every 3 s (§9).
- **The server never mutates a project.** AI jobs return *results* (a transcript, highlight ranges, reframe keyframes). The client applies them as ordinary undoable commands. This removes any write conflict between users and workers.

---

## 2. System overview

```
┌──────────────────────────── Client (web or Tauri) ────────────────────────────┐
│ Main thread: React UI · timeline (canvas + hidden a11y DOM) · Zustand/Immer    │
│   │ commands → patches → undo stack ─┬─► IndexedDB op-log (instant)            │
│   │                                  └─► sync queue ──(POST /ops) ──► API       │
│ Render worker: demux (mediabunny) → WebCodecs decode → cutforge-engine (wasm)   │
│                → OffscreenCanvas │ export: → WebCodecs encode → mux → OPFS     │
│ Text worker: libass+HarfBuzz (JASSUB build) → glyph bitmaps → engine           │
│ Analysis worker: Silero VAD (onnxruntime-web), RMS envelope, auto-grade stats  │
│ Desktop only: same UI in the webview; Rust side runs engine + LGPL FFmpeg       │
└─────────────────────────────────────────────────────────────────────────────────┘
          │ tus (resumable)          │ REST + SSE             │ signed GETs
          ▼                          ▼                        ▼
   ┌────────────┐  post-finish  ┌──────────┐            ┌──────────────┐
   │ tusd       │──── hook ────►│ FastAPI  │──signs────►│ CloudFront   │
   │ (S3 store) │               │ (ECS)    │            │ → S3 (per-   │
   └────────────┘               └────┬─────┘            │ user prefix) │
                                     │ jobs (Postgres = truth,          └──────────────┘
                                     │      Redis/Celery = transport)
          ┌──────────────────────────┼─────────────────────────────┐
          ▼                          ▼                             ▼
   ingest (Fargate, CPU)      ai-gpu (EC2 spot, L4/A10G)     export (GPU spot / CPU)
   clamscan · ffprobe ·       faster-whisper · CTC align ·   cutforge-render ·
   proxy · thumbs · peaks ·   IndicTrans2 · IndicXlit ·      segment-parallel ·
   16 kHz audio · log detect  MediaPipe faces · scenes ·     NVENC / x264
                              highlight scoring (LLM)
```

---

## 3. Monorepo layout (built in Deliverable 2)

```
apps/web            React + TS + Vite (also the Tauri frontend)
apps/desktop        Tauri v2 shell (Rust): native FFmpeg I/O, engine, local FS, updater
engine/             Cargo workspace
  cutforge-engine     compositor, WGSL shaders, grade/LUT baker, audio mixer, ASS generator
  cutforge-render     CLI: project.json + asset map → file (cloud export)
  cutforge-wasm       wasm-bindgen bindings for the web worker
packages/project-schema   JSON Schema (source of truth) → generated TS types, Pydantic, Rust (typify)
packages/ui         shared components, i18n (hi/en), themes
services/api        FastAPI
services/worker     Celery tasks (ingest, ai, export)
infra/              Terraform (AWS), docker images
tests/golden        golden-frame fixtures + blessed PNGs
tests/bench         WER + silence-cutter benchmarks
```
Tooling: pnpm workspaces + Turborepo, Cargo workspace, `uv` for Python, GitHub Actions.

---

## 4. Client architecture

**Threads.** The main thread never decodes, renders or analyses: "no UI blocking, ever" is enforced by structure, not by care.

| Thread | Owns |
|---|---|
| Main | React, Zustand store, command bus, timeline drawn on `<canvas>` (thousands of items without DOM cost) plus a visually hidden DOM mirror for screen readers |
| Render worker | Demux, decoder pool, frame cache, engine, preview canvas (`OffscreenCanvas`), browser export |
| Text worker | libass rendering of the ASS script the engine generates |
| Analysis worker | VAD, RMS envelope, auto-grade statistics, scopes |
| Audio | `AudioWorklet` fed by the engine's mixer (wasm) |

**State.** Zustand slices: `project` (Immer, persisted), `history`, `playback` (playhead lives in a `SharedArrayBuffer` so the worker reads it without messages, which needs COOP/COEP headers), `ui`, `jobs`, `device`. Components subscribe with selectors only.

**Commands.** Every edit (`trimItem`, `splitAt`, `rippleDelete`, `applyCutSet`, `applyReframe`, …) is a pure function `(draft, args) => void` in `apps/web/src/commands/`. Compound actions such as "apply 37 silence cuts" or "make 5 reels" are **one** history entry. Shortcuts: J/K/L shuttle, S split, Ctrl/Cmd+Z / Y, plus the standard set, all remappable.

**Media access.**
- Web: files dropped by the user go into OPFS right away, so editing starts before the upload finishes. Uploads run in the background over tus.
- Desktop: files are referenced in place by path, and uploaded only when a cloud feature needs them.
- Proxies: the server makes them for web uploads. Desktop makes them locally with FFmpeg. A web user who is offline with a source of 1440p or more gets an in-browser WebCodecs proxy. Thumbnails and the waveform are always computed on the client too, because they are cheap and must appear instantly.

---

## 5. Render pipeline (the shared compositing spec)

The engine evaluates one frame at time `t` for a sequence. The order is normative: golden tests pin it.

1. **Resolve.** For each track from the bottom up, find the active items at `t`. Map `t` to source time: constant speed gives `sourceIn + (t − start)·rate`; a ramp integrates its rate keyframes; reverse mirrors the result. Snap to the nearest source frame (no frame blending in v1).
2. **Decode → RGB.** Y′CbCr → R′G′B′ with an explicit matrix and range from asset metadata (BT.601/709/2020, limited/full), written in our own shader. We never use the browser's implicit `VideoFrame` conversion for export, because it differs between implementations.
3. **Grade = one 3D LUT per clip.** The input transform (S-Log3, Apple Log, D-Log M, HLG→SDR), white balance (Bradford CAT from the estimated illuminant to D65), exposure, contrast around 18% grey, the tone curve (blacks/shadows/highlights/whites), saturation/vibrance, the look (mood preset or imported `.cube`) mixed by intensity, and **skin-tone protection** are all functions of the input colour only. The engine therefore **bakes them into a 65³ RGBA32F LUT on the CPU** (shared Rust code, deterministic) whenever grade parameters change. A 33³ LUT is used while a slider is being dragged. The shader does one **tetrahedral** lookup written with `textureLoad`, never hardware filtering, because many GPUs use 8-bit filter weights. Parity for grading thus reduces to "same LUT bytes + same 20 lines of interpolation", which is easy to test. The grade stays fully parametric in the project and is never baked into the media.
4. **Reframe / transform.** Fit, Fill or Blur-background for the sequence aspect, then the reframe keyframes (crop centre + zoom), then the user transform (position, scale, rotation, opacity, crop). All spatial values are **resolution-independent**: positions are normalised to the frame, and sizes and blur radii are fractions of output height. That is what lets a 540p proxy preview frame the same as a 4K export. Resampling: manual Catmull-Rom; a box pre-filter pyramid when scale < 0.5.
5. **Transitions.** Fade, dip-to-black, slide, zoom and wipe are WGSL functions of `(A, B, progress)`.
6. **Composite.** Premultiplied alpha, in display-referred (gamma-encoded) space, as designers expect.
7. **Text and captions.** The engine generates an ASS script from text items and caption sets (karaoke `\kf`, pop-in `\t`, outline, shadow, box, safe-area margins). **libass** renders it with HarfBuzz shaping, using **only bundled font files** loaded from memory, with the system font provider and hinting both off. This gives the same conjunct and matra shaping on every OS and at every resolution.
8. **Output.** R′G′B′ → BT.709 limited Y′CbCr 4:2:0 (2×2 box chroma), done by us. Browser export builds `VideoFrame`s from our own I420 planes.

**Preview-only overlays** are excluded from parity: before/after split, zebra/clipping warnings, safe-area guides, scopes. **HDR**: HLG/PQ sources are tone-mapped to SDR Rec.709 in v1. HDR export is out of scope.

**Audio** is mixed by the engine at 48 kHz float: per-clip gain and fades, transition crossfades, and speed changes with pitch kept by a time-stretcher (Signalsmith Stretch, MIT). Export loudness is normalised per preset (for example −14 LUFS for YouTube and Reels).

### Golden-frame tests (definition of "identical")

Bit-exact output across GPUs is physically impossible because floating-point precision differs between devices. The parity contract is:

- **Pixel stage** (before encode, same resolution, same decoded input frames from PNG fixtures): for every fixture, comparing the native engine (lavapipe in CI), the web engine (Chromium WebGPU and WebGL2 in Playwright) and the blessed PNG, the maximum per-channel difference is ≤ 2/255 on ≥ 99.9% of pixels, and PSNR ≥ 48 dB.
- **End to end** (decode + encode): SSIM ≥ 0.98 against the blessed reference, with the preview path compared to the export path.
- **Grade unit tests**: synthetic fixtures (a grey card at −1.5 EV, a 3200 K cast, a skin patch set across Fitzpatrick I–VI) must converge to within ΔE₀₀ ≤ 2 of the target after Auto Grade. Skin patches must not move by more than ΔE₀₀ 4 under any mood look at 100%.

---

## 6. Ingest pipeline

1. `POST /v1/assets` checks the quota and declared size, then returns an `assetId` and tus endpoint. The client sniffs magic bytes first to give a fast error, but the server check is the one that counts.
2. tusd (S3 store, 8 MB chunks, resumable across network changes) receives the file. Its `pre-create` hook checks the JWT and that the user owns the asset. Its `post-finish` hook enqueues `ingest`.
3. `ingest` runs in a **Fargate task** (a Firecracker microVM per task, which gives sandboxing for free). Steps:
   - libmagic on the first bytes, against an allow-list: MP4/MOV/MKV/WebM/MP3/WAV/PNG/JPG, plus `.cube` validated by parsing.
   - `clamscan`.
   - `ffprobe` with `-protocol_whitelist file`, then duration and stream checks against the plan quota.
   - Outputs: a 540p proxy (short side 540, H.264 main, 1 s GOP, no B-frames for fast seeking, AAC 128k); a WebP thumbnail sprite (1 frame / 2 s, 160 px) plus its index; waveform peaks (int8, 3 zoom levels); 16 kHz mono Opus for AI; a log-profile guess (metadata tags plus a histogram test for flat footage).
4. Failure → `failed` with a reason. A virus hit → `quarantined`: the object is moved to a no-read prefix and the user is told.

URL import supports direct media URLs and Google Drive/Dropbox share links. It **does not support YouTube or Instagram downloading** (terms-of-service and copyright exposure). The fetcher resolves DNS once, refuses private, link-local and metadata IP ranges, follows at most 3 redirects with the same checks each time, and streams to tus with a size cap.

---

## 7. AI pipelines

All AI runs on the `ai-gpu` queue. Each job is idempotent and checkpointed to S3, so a spot interruption resumes from the last chunk.

| Feature | How | Where |
|---|---|---|
| **Transcription** | Silero VAD → chunks ≤ 30 s → faster-whisper large-v3 (fp16, `word_timestamps`) with language `hi`/`en`/auto. **Forced-alignment pass** with a Hindi/English CTC model (candidate: AI4Bharat IndicWav2Vec; licence to verify) because Whisper's word times are ±100–300 ms, too loose for karaoke and filler cuts. Output: words with source-time flicks and confidence. | GPU |
| **Hinglish (Roman Hindi)** | Transcribe in Devanagari, then IndicXlit → Latin. English words keep their spelling through a dictionary. | GPU |
| **Mixed language** | Per-segment language ID from Whisper; segments flagged `mixed`. Display policy, per track: "English words in Latin script" or "all Devanagari". | GPU |
| **Translation hi↔en** | IndicTrans2, per segment; the result is a new caption set `derivedFrom` the source with the same segment IDs and timings. Word times for karaoke are estimated in proportion to characters (flagged as estimated). | GPU |
| **Fix subtitles** | (1) custom dictionary (names, brands; matched in both scripts through transliteration-normalised keys); (2) rules: Unicode NFC, nukta/anusvara/chandrabindu normalisation, numerals, consistent loanword spelling; (3) optional LLM pass (Claude Sonnet 5.5) limited to minimal edits. Output is a list of **suggested edits** the user accepts or rejects, never a silent rewrite. | GPU + API |
| **Speaker labels** | pyannote 3.1 diarization (opt-in, costs extra GPU time). | GPU |
| **Scene split** | PySceneDetect (adaptive detector) on the proxy. | CPU |
| **Auto-reframe** | MediaPipe face detector at 5 fps on the proxy → IoU tracker → primary subject (size × time on screen × centrality, cut at scene changes) → virtual-camera path solver (dead zone, velocity and acceleration limits, ease-in/out) → sparse keyframes (RDP-simplified) per aspect, editable. No face → object detector (MediaPipe EfficientDet-Lite) → motion/saliency centroid. | GPU/CPU |
| **Highlights** | Candidate windows of 15/30/60 s ±20% aligned to sentence ends. Score = weighted mix of: an LLM "hook / self-contained / payoff" score over the transcript (Claude Haiku 5.5, transcript text only, never media), speech rate, loudness dynamics, face presence. The reason is written in the UI language. If the LLM is down, the score is heuristic only and the reason comes from a template. | GPU + API |
| **Make 5 reels** | A *client macro*: request highlights → reframe 9:16 for the chosen ranges → locally apply the silence cut, Auto Grade and the Reel style → 5 new sequences in one undoable command. | client + GPU |
| **Silence cutter** | The client computes, once per asset, the Silero VAD speech probability (32 ms frames, onnxruntime-web) and an RMS envelope from the proxy audio (worker, offline-capable). Threshold, minimum length, padding, keep-short-pauses and mode are a **pure TS function** over that data, so the sliders update the red regions instantly. Fillers come from transcript words (a default list per language plus the user's list). Whisper tends to *omit* disfluencies, so the CTC alignment pass is also where "um/uh/मतलब" are recovered (risk R3). Applying = one command that splits and ripple-deletes (or speeds up, in Shorten mode) the clips that use the asset. Smoothing: 10 ms audio crossfades, plus a 105–110% punch-in on alternate segments. | client |
| **Auto Grade / Match** | Analysis in the engine (wasm, worker) on about 8 proxy frames per clip: luminance percentiles → exposure/contrast; grey-world white balance with skin and saturated pixels excluded → illuminant; saturation statistics. **Match**: fit our parametric controls to the reference clip's Lab statistics (Reinhard-style), so the result stays editable sliders, not a black-box transform. | client |

**Models are pinned by hash.** Every result records `model` and `modelVersion`, so a re-run with a newer model is explicit.

---

## 8. Export

- **Browser (free tier).** Render worker → engine → WebCodecs `VideoEncoder` (H.264 / VP9 / AV1, whatever the browser offers) → mediabunny mux → OPFS → download. Rendering is **in 10 s segments**, so a crash or closed tab resumes from the last segment. Long exports are steered to desktop or cloud. GIF uses gifenc (MIT) from engine frames.
- **Desktop.** Same engine, native: FFmpeg hardware encoders (`h264_videotoolbox`, `h264_mf`, `h264_nvenc`, `h264_qsv`, `h264_amf`; HEVC the same way). With no hardware encoder: Cisco OpenH264, downloaded from Cisco at first use so their patent licence covers it, or VP9 (libvpx) / AV1 (SVT-AV1).
- **Cloud (paid: 4K + AI).** The `export` job splits the sequence into closed-GOP segments, renders them **in parallel** with `cutforge-render` (NVENC or x264), renders the audio once, then concatenates with stream copy and muxes. Segments are checkpointed: resume = render the missing segments only. Progress and ETA come from completed segments × measured throughput. Completion is announced over SSE plus Web Push (VAPID) and native desktop notifications.
- **Presets** (data, not code): YouTube 1080p/4K, Reels/Shorts 1080×1920, WhatsApp (≤ 16 MB target-size two-pass, 720p), audio-only (AAC/MP3), GIF. Frame rates 24 to 60, codecs H.264/H.265/VP9/AV1 depending on target.

---

## 9. Autosave, sync, crash recovery, offline

1. **Every command** appends its patches to an IndexedDB op-log in the same tick. The worst case on a crash is the in-flight keystroke. A full snapshot is written every 200 ops or 30 s; recovery = last snapshot + replay of the op-log.
2. **Server sync**, every 3 s when ops are pending: `POST /v1/projects/{id}/ops {baseRevision, ops}`. The server checks `baseRevision == revision`, applies the patches, **validates against the schema**, bumps `revision` and appends to `project_ops`. A full version snapshot is written every 100 revisions and on manual "Save version".
3. **One editor at a time**: `POST /lease` (60 s TTL in Redis, renewed every 20 s). A second tab or device opens read-only with a "Take over" button. Taking over drops the old holder's lease and the old holder goes read-only.
4. **Offline divergence** (desktop edits offline while the web edited online): on reconnect, the 409 response carries the server revision. The client **never discards either side**. Its offline branch is saved as a new version tagged `conflict`, and the user chooses which to continue. Merging is left out on purpose (single-user product).
5. **Schema migrations**: `schemaVersion` is an integer. Migrations are pure TS functions vN→vN+1. The client migrates on open. The server accepts writes at the current version only. A backfill job (Node) migrates stored projects at deploy time, so Python and the renderer only ever see the current version.
6. **Offline**: the web app is a PWA (service worker caches the shell and wasm). Editing, preview, browser export, silence detection and Auto Grade work offline. AI jobs queue and run on reconnect. The desktop app is offline-first by default.

---

## 10. Backend and infrastructure (AWS ap-south-1)

| Component | Choice | Notes |
|---|---|---|
| API | FastAPI on ECS Fargate behind ALB + WAF | Stateless; Pydantic models generated from the schema |
| Uploads | tusd (MIT) on Fargate, S3 store | Hooks call the API |
| DB | RDS Postgres 16, Multi-AZ | Row-level security on owner tables as defence in depth |
| Queue | ElastiCache (Valkey/Redis) + Celery | Postgres `jobs` table is the source of truth; `acks_late`, `reject_on_worker_lost`, exponential-backoff retries (max 5), idempotent tasks with deterministic output keys |
| CPU workers | Fargate (ingest, scenes) | Auto-scaled on queue depth |
| GPU workers | ECS on EC2 spot (g6/L4 or g5/A10G, whichever the region has) via a capacity provider; min 0 | On spot interruption notice: stop consuming, checkpoint, requeue |
| Storage | S3, keys `u/{userId}/a/{assetId}/…`; CloudFront signed URLs (15 min) | Lifecycle: exports expire after 30 days, deleted assets purged after 7 |
| Secrets | Secrets Manager; KMS | |
| IaC | Terraform | Environments: dev / staging / prod |
| LLM | Claude via Amazon Bedrock if the model is offered in-region, otherwise the Anthropic API | Behind one `LLMProvider` interface; transcript text only |

---

## 11. Security

- **Parsing hostile media.** FFmpeg runs only in Fargate microVMs (ingest) or in nsjail on GPU hosts: no network, read-only root, tmpfs work dir, CPU/memory/time rlimits, non-root, `-protocol_whitelist file,pipe`. The desktop app only parses files the user picked.
- **Upload trust boundary.** Magic-byte allow-list, ClamAV, size/duration quotas per plan, a per-file maximum enforced in tusd. Honest note: AV catches little in media files. The real defence is sandboxed parsing, and the fact that originals are only ever served back to their owner (`Content-Disposition: attachment`, `nosniff`).
- **Isolation.** Every query is scoped by `owner_id` (plus RLS). Signed URLs are issued only after an ownership check. The S3 bucket is private, with no public ACLs.
- **Auth.** Phone OTP (rate-limited, 6 digits, 5 attempts, 10 min TTL, hashed) and Google OIDC. Short-lived JWT access tokens (15 min) and rotating refresh tokens with reuse detection, in an httpOnly cookie on web and the OS keychain on desktop.
- **Rate limits.** Redis token buckets per user and per route class (auth, writes, job submits); WAF rules per IP.
- **Desktop.** Tauri v2 capability allow-list, strict CSP, FS scope limited to user-chosen folders, signed auto-updates, Apple notarisation and Windows Authenticode.
- **Privacy (DPDP Act 2023 and its 2025 Rules).** Consent notice in Hindi and English; `DELETE /v1/me` erases data with a published SLA; breach-notification runbook. **Users under 18 need verifiable parental consent**, so the sign-up needs an age gate (risk R9). Share links expire and are `noindex`.

---

## 12. Reliability and observability

- Structured JSON logs (structlog / tracing), OpenTelemetry traces from API → worker → engine, Sentry for web, desktop (Rust panics included), API and workers.
- `/healthz` (liveness) and `/readyz` (DB + Redis). Workers use a Celery ping health check.
- SLOs at launch: API p95 < 300 ms; ingest of a 10-min 1080p file < 2 min; transcription < 0.25× real time; zero lost user edits.
- **Graceful degradation.** AI outages never block editing. Jobs show `delayed`, a banner explains it, and circuit breakers wrap the LLM and GPU queues.

---

## 13. Performance budget and device tiers

- **Target**: 60 fps preview of a 1080p sequence from 540p proxies on an 8 GB laptop with integrated graphics.
- **Decoder pool** with look-ahead (2 GOPs). Frame cache in GPU textures, capped by `device.memory`. **Every `VideoFrame` is `close()`d through an ownership wrapper**, because leaked frames are the main cause of crashes in WebCodecs apps.
- **Device tier** is detected at first run from `deviceMemory`, `hardwareConcurrency`, GPU adapter limits and a 2-second render benchmark:
  - *Full*: live grade, blur-background and transitions at 60 fps.
  - *Lite* (low-end laptops, mobile browsers): 360p proxies, 30 fps preview, 33³ LUTs, blur-background drawn at ¼ resolution, scopes off by default, a single decoder.
- Timeline: canvas-drawn, virtualised, 60 fps at 5,000 items. Store selectors are memoised. No React re-render on playhead ticks: the playhead is drawn on its own canvas layer.

---

## 14. Accessibility and i18n

- The canvas timeline has a **parallel hidden DOM** (tracks as lists, items as buttons with labels such as "Clip 3, 4.2 seconds, starts 0:12"). Roving focus; arrows step a frame, Shift+arrows a second. `aria-live` announces edits ("Trimmed to 4.2 s").
- Silence regions are drawn red **with a hatch pattern**, so colour is not the only signal. `prefers-reduced-motion` is respected. Light and dark themes meet WCAG AA contrast.
- UI in Hindi and English (react-i18next, ICU plurals). UI fonts: Mukta / Noto Sans Devanagari, with taller line-height for matras.

---

## 15. Testing and quality metrics

| Area | Method | Pass bar (v1) |
|---|---|---|
| Unit | Vitest (commands, silence function, sync), pytest (API, tasks), `cargo test` (engine, LUT baker, ASS generator) | Run in CI on every PR |
| E2E | Playwright: upload → trim/split → ratio → export; offline edit → reconnect; crash → recovery | Run in CI |
| Golden frames | §5 contract across native, WebGPU and WebGL2 | ≤ 2/255 on 99.9% of pixels |
| Hindi ASR | Test set: Common Voice hi (CC0) + IndicVoices hi (CC-BY-4.0) + **3 h of our own consented creator-style Hinglish recordings**, hand-transcribed. Report **WER and CER** after normalisation (NFC, nukta, punctuation; Hinglish compared after transliteration to one script). | Baseline in D4; the target is set from that baseline |
| Silence cutter | Clean speech (hi/hinglish/en) mixed with MUSAN noise (CC-BY-4.0) at 0–20 dB SNR, with known inserted silences. **False-cut rate** = speech removed / total speech. **Missed-silence rate** = silences ≥ min length left in / total such silences. **Sync**: caption start error after cuts. | False-cut < 0.5%, missed < 10%, sync ≤ 1 frame |
| Auto-grade | §5 synthetic fixtures + 40 real clips covering **all skin tones**, rated by humans A/B | ΔE₀₀ targets in §5 |
| CI | Lint (eslint, ruff, clippy), typecheck (tsc, mypy, cargo check), tests, golden, wasm size budget | Must pass to merge |

---

## 16. Legal and licensing review

**These are engineering findings, not legal advice. Get counsel (Indian IP and privacy) before launch.**

### Codecs
| Item | Finding | Action |
|---|---|---|
| H.264 (Via LA pool) | Free-to-viewer internet video carries no content royalty. **Encoder/decoder products** owe royalties above 100k units/yr. | Desktop uses OS/GPU encoders (their licence covers it) or Cisco's OpenH264 binary. Browsers use their own encoder. Server-side encoding as a service: confirm with counsel. |
| H.265/HEVC | Several pools (Access Advance, Via LA) plus independent licensors. Highest risk. | HEVC only through OS/GPU encoders; not default; never software x265 in a shipped binary. |
| VP9 / AV1 | Royalty-free licences from Google / AOMedia. Third-party pool claims exist for AV1. | Fine as fallbacks; keep watching. |
| FFmpeg | LGPL-2.1 when built without GPL parts. | Desktop: LGPL build, dynamically linked, licence notice, source offer, relinkable. Server: GPL build with x264 is fine because it is not distributed. |
| **ffmpeg.wasm** | The default `@ffmpeg/core` build **includes x264 and is GPL**. Shipping it to browsers counts as distribution. | Build our own LGPL wasm core (demux/decode fallback only). |

### Fonts
Noto Sans Devanagari, Mukta and Poppins are all **SIL OFL 1.1**: bundling and burned-in rendering are allowed. We may not sell the fonts alone, and a modified font must be renamed (Reserved Font Name). Include the OFL text in the about screen and in desktop builds.

### Libraries
| Use | Pick (licence) | Avoid (licence) |
|---|---|---|
| Subtitles | libass (ISC), HarfBuzz (MIT), FreeType (FTL, use the credit clause), **FriBidi (LGPL-2.1)**, JASSUB (MIT) | — FriBidi in a wasm bundle: ship as a separate replaceable module and publish build scripts |
| Time-stretch | Signalsmith Stretch (MIT), SoundTouch (LGPL) | Rubber Band (GPL / commercial) |
| GIF | FFmpeg palettegen, gifenc (MIT) | **gifski (AGPL-3.0)** |
| Waveform | own peaks code | audiowaveform (GPL-3.0) — fine on server, avoid in clients |
| Demux/mux | mediabunny (MPL-2.0, file-level copyleft: fine) | |
| Uploads | tusd (MIT) | |
| AV | ClamAV (GPL-2.0), server only | |

### AI models
| Model | Licence | Note |
|---|---|---|
| Whisper large-v3 weights, faster-whisper, CTranslate2 | MIT | — |
| Silero VAD | MIT | — |
| IndicTrans2, IndicXlit (AI4Bharat) | MIT | Re-check the licence of the exact checkpoint we pin |
| IndicWav2Vec (alignment) | To verify | Before D4 |
| MediaPipe face / object detectors | Apache-2.0 | — |
| PySceneDetect | BSD-3 | — |
| pyannote 3.1 | MIT, gated download | Accept the terms with a company account |
| **InsightFace / RetinaFace pretrained** | **Non-commercial** | **Do not use** |
| **Ultralytics YOLO** | **AGPL-3.0** | **Do not use** (or buy the licence) |
| Claude (Bedrock or API) | Commercial terms | Disclose in the privacy notice that transcript text goes to an LLM provider; make it opt-out |

### Content
- **LUTs**: ship only LUTs we author. Log input transforms are implemented **from the vendors' published formulas** (Sony S-Log3/S-Gamut3, Apple Log), so no vendor LUT files are redistributed. For D-Log M, if no formula is published, the user imports DJI's LUT.
- **Music and SFX**: none bundled at launch. If added later: a library with written per-track commercial and sync licences. Indian public-performance bodies (IPRS/PPL) are a separate question for any music feature.
- **Hosting user content**: we are not a public platform in v1 (share links are private), which keeps us light under the IT Rules 2021. Still appoint a grievance officer and publish a takedown process.

---

## 17. Risks (ranked)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Preview/export parity drifts | Core promise broken | ADR-001 single engine; LUT-based grading; golden tests gate every PR |
| R2 | Rust/wgpu/wasm is a skill and maturity bet; WebGL2 fallback limits (no compute, float render targets need an extension) | Slower D3 | Engine scope kept small (no compute shaders in v1); a 1-week spike in D2 proves wgpu on WebGPU + WebGL2 + lavapipe before anything else is built on it |
| R3 | Hindi/Hinglish ASR quality; Whisper hallucinates on silence and drops fillers; loose word times | The wedge | VAD chunking, CTC forced alignment, filler recovery from the CTC pass, benchmark **first in D4** with fine-tuned Hindi checkpoints compared |
| R4 | Webview gaps: Linux WebKitGTK lacks WebCodecs/WebGPU; older macOS WebKit | Desktop parity | Windows (WebView2 = Chromium) and macOS 26+ first; Linux later, with native preview |
| R5 | Mobile browser memory (iOS tab kills at about 1–1.5 GB), Safari audio WebCodecs gaps | Crashes on phones | Lite tier, a single decoder, frame-ownership wrapper, ffmpeg.wasm audio fallback, mobile-specific e2e on real devices (BrowserStack) |
| R6 | GPU cost and spot interruptions | Margin, latency | Scale to zero, chunk checkpoints, per-plan minute quotas, 16 kHz audio sent to ASR (not video) |
| R7 | Upload reliability and data cost on Indian mobile networks | Churn | tus resume; editing starts before upload ends; desktop and web-offline edit locally |
| R8 | Codec patents (esp. HEVC) | Legal | §16 posture |
| R9 | DPDP compliance, especially minors | Legal | Age gate + parental consent flow before public launch; erasure endpoint |
| R10 | Auto-grade / reframe bias on darker skin tones | Product trust | Test sets balanced across skin tones; the skin-protection metric is a release gate |
| R11 | Devanagari edge cases: karaoke splits inside a grapheme cluster; colour emoji (libass renders mono) | Visible bugs | Split only on `Intl.Segmenter` word and grapheme boundaries; emoji documented as monochrome in v1 |
| R12 | Scope: 7 deliverables, each large | Time | Strict MVP cut in D3; every AI feature behind a flag |

---

## 18. Deliverable 3 (MVP) cut, for planning

In: upload (tus) and ingest; proxies, thumbs and peaks; one sequence; video, audio and text tracks; drag, trim, split, ripple delete, snapping, zoom, undo/redo; ratio presets with Fit/Fill/Blur; browser export (H.264 MP4, 720p/1080p) plus desktop export; autosave and recovery; Hindi/English UI shell.
Out until later: transitions, keyframes UI, grade, captions, AI, cloud export, billing.

## 19. Open questions for you (not blocking D2)

1. Plan limits for the free tier. My placeholders: 5 GB storage, 30 min max per file, 60 transcription minutes per month, 1080p browser export with no watermark.
2. Is a watermark on free exports acceptable?
3. Do you have, or can you record, 3 h of consented Hinglish creator audio for the benchmark? A public set alone will overstate accuracy on real creator speech.
