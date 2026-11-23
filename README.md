# CutForge

[![ci](https://github.com/Abhishek2114/cutforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Abhishek2114/cutforge/actions/workflows/ci.yml)

A Hindi-first, non-destructive video editor for Indian creators, built as a web app and a desktop app (Tauri) from one codebase. The wedge: accurate Hindi/Hinglish/English subtitles with correct Devanagari rendering, one-click reels, auto colour grading, an auto silence cutter, and smooth editing on mid-range laptops and phones.

**Status:** Deliverable 1 (architecture, data model, project schema, API spec, risks) is complete. A working MVP editor (Deliverable 3 scope) runs in the browser: [apps/web](apps/web).

## Run the editor

**Live:** https://abhishek2114.github.io/cutforge/ (deployed from `main` by [pages.yml](.github/workflows/pages.yml)). Best in Chrome or Edge.

Or run locally:
```bash
cd apps/web && npm install && npm run dev
```
Open http://localhost:5173 and drop in a video (MP4, MOV, WebM or MKV). You can then:
- trim (drag the clip edges), split (S), ripple-delete (Del), undo/redo (Ctrl/⌘+Z/Y);
- switch ratio (16:9, 9:16, 1:1, 4:5, 21:9) with Fit / Fill / Blur-background framing;
- export an MP4 (WebM in browsers without an MP4 recorder);
- switch the UI between Hindi and English;
- click **✨ Auto edit** (or press A) to let the app decide three things in one undoable step:
  - **cut silences and dead air:** Silero VAD, a neural voice detector, tells speech apart from fans, traffic and breathing. It only cuts pauses over 0.5 s and keeps 0.1 s of breathing room, and if it hears no voice at all (music) it cuts nothing. If the model can't load, it falls back to loudness relative to the recording's own noise floor;
  - **fix colour:** brightness, contrast and saturation from frame statistics, stored as editable settings;
  - **pick framing:** Fill when the crop is small, otherwise Blur-background.

  It runs entirely in the browser, so it's free, private and works offline. The model (MIT) and the ONNX runtime (MIT) are self-hosted under `/vad/` and download once (about 4 MB compressed) on first use.

Every edit autosaves, and reloading the page restores the project and its media.

MVP limits, all planned in the architecture:
- one video track;
- no server upload;
- export runs in real time through the browser's recorder (MediaRecorder);
- the shared wgpu render engine (ADR-001) replaces the Canvas 2D renderer in D2/D3.

## Contents

| File | What it is |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, render pipeline, AI pipelines, sync/autosave, security, performance, testing, **legal & licensing review**, ranked risks |
| [docs/data-model.sql](docs/data-model.sql) | Postgres 16 schema (users, assets, projects + op log + versions, jobs, transcripts, clip library, dictionary, billing, RLS) |
| [packages/project-schema/project.schema.json](packages/project-schema/project.schema.json) | JSON Schema for the project document (EDL) |
| [packages/project-schema/examples/](packages/project-schema/examples/) | Example projects: a Hindi vlog with a 9:16 reel, karaoke captions, auto grade and silence cuts; a minimal new project |
| [docs/api.yaml](docs/api.yaml) | REST API, OpenAPI 3.1 (36 endpoints) |

## Brief coverage

The brief asks for 7 deliverables, with a stop for approval after each. Deliverable 1 is complete, and the core of the Deliverable 3 MVP is working in [apps/web](apps/web). Every other feature in the brief is designed here, with code arriving in Deliverables 3–7. `§` refers to sections of [architecture.md](docs/architecture.md).

| Brief requirement | Where it is answered | Status |
|---|---|---|
| ≤ 5 clarifying questions before starting | §0 (hosting, translation engine, collaboration, codec licensing) | Done |
| 1. Upload: tus, magic bytes, proxies, thumbs, waveform | §6 · API `/v1/assets` · `assets` table | **Local import with magic-byte check built + tested**; server upload designed |
| 2. Sequence: multi-track, trim/split/ripple, unlimited undo | §1 Bet 3, §4 · schema `sequence/tracks/items` | **Trim/split/ripple/undo built + tested (one track)**; multi-track designed |
| 3. Ratio presets, Fit/Fill/Blur, auto-reframe | §5 step 4, §7 · schema `clip.reframe` per aspect · API `reframe` job | **Presets + Fit/Fill/Blur built**; auto-reframe designed |
| 4. Motion, transitions, keyframes, speed ramps | §5 steps 1, 5 · schema `transition`, `keyframe`, `speed` | Designed |
| 4. Auto colour grading, match, log, LUT, skin protection, parity | §5 step 3 (one 3D LUT per clip) + golden-frame contract, §7 · schema `grade`, `look` | **One-click auto colour (exposure/contrast/saturation) built + tested**; match, LUTs, skin protection designed |
| 5. Hindi/English/Hinglish subtitles, translate, transliterate, fix pass | §7 · API `transcribe/translate/transliterate/fix_subtitles` · `transcripts`, `dictionary_entries` | Designed |
| 5. Devanagari rendering (HarfBuzz, libass, Noto/Mukta/Poppins) | §5 step 7 · schema `textStyle/captionStyle` (bundled fonts only) | Designed |
| 5. Subtitles stay in sync after edits | §1 Bet 2: captions stored in source time | Designed |
| 6. Highlights, make 5 reels, clip library | §7 · API `highlights` · `library_clips` | Designed |
| 6. Auto silence cutter: VAD, controls, modes, review, smoothing, fillers | §7 · schema `cutSets` (editable regions, accept/reject) | **One-click silence removal built + tested** (Silero VAD with a loudness fallback, padding, undoable); review mode and filler words designed |
| 7. Export: formats, presets, queue, resume, notifications | §8 · API `export` job, `/v1/events` | **Browser MP4/WebM export built**; presets, queue, cloud designed |
| Non-destructive versioned JSON + migrations | §9 · [project.schema.json](packages/project-schema/project.schema.json) | **Built + tested** (the editor's saved project validates against it in CI) |
| Autosave, crash recovery, offline | §9 | **Local autosave + recovery built**; server sync designed |
| Performance, low-end mode, accessibility, Hindi UI | §13, §14 | **Hindi/English UI, keyboard shortcuts, screen-reader labels built**; perf tiers designed |
| Security & reliability | §11, §12 · Postgres row-level security | **RLS built + tested in CI** |
| Legal & licensing review | §16 | Done (needs counsel review) |
| Quality bar: WER, golden frames, silence false-cut rate | §15 (methods + pass bars) | Planned for D3–D6 |
| Deliverable 1 files: architecture, data model, schema, API spec, risks | `docs/`, `packages/project-schema/`, §17 | **Done, CI green** |

## Key decisions

1. **One render engine everywhere.** A Rust + wgpu + WGSL compositor runs as WebAssembly for the browser preview, natively in the desktop app, and as a CLI for cloud export. FFmpeg only decodes, encodes and muxes. This is what makes "preview = export" achievable and testable.
2. **Colour grade = one 3D LUT per clip.** Exposure, white balance, log input transforms, the mood look and skin-tone protection are baked into a 65³ LUT by shared code. Parity is verified by golden-frame tests (≤ 2/255 per channel).
3. **Captions and cuts live in source time.** Subtitles stay in sync through trims, silence cuts, speed changes and reels with no fix-up code.
4. **Edits are JSON patches.** They give unlimited undo, instant IndexedDB autosave and server sync with revisions plus a single-editor lease, so user work is never lost.
5. **India-specific choices.** AWS Mumbai with spot GPUs; self-hosted AI4Bharat IndicTrans2/IndicXlit; faster-whisper + forced alignment for Hindi; editing starts locally before the upload ends.

## Verify

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push:
1. The project schema accepts both examples and rejects 18 deliberately broken documents.
2. The API spec is valid OpenAPI 3.1.
3. The data model loads into a real Postgres 16.
4. Row-level security holds ([tests/sql/rls_smoke.sql](tests/sql/rls_smoke.sql)): a user sees only their own rows, cannot write rows for another user, and sees nothing when no user is set.
5. The web editor typechecks, passes its unit tests ([model.test.ts](apps/web/src/model.test.ts): split, trim, ripple-delete, reorder, ratio, undo/redo, magic bytes, and the saved project validating against the schema), and builds.
6. An end-to-end test ([e2e/editor.spec.ts](apps/web/e2e/editor.spec.ts)) drives the real app in a browser and uses every control:
   - import via the drop zone and "Add video", and rejecting a fake file;
   - play/pause, timeline seek, split, delete, undo/redo and the keyboard shortcuts;
   - reordering, all 5 ratios, Fit/Fill/Blur, drag-trim and zoom;
   - export, checking that the merged file has the right size, length and clip order;
   - reload recovery, the Hindi/English toggle and New project;
   - no console errors anywhere.

   To run it against the live site: `cd apps/web && BASE_URL=https://abhishek2114.github.io/cutforge/ PW_CHANNEL=chrome npm run e2e`.

To run check 1 locally:
```bash
python3 packages/project-schema/check_schema.py
```

## Roadmap

1. Architecture, data model, schema, API ✅
2. Monorepo scaffold + CI
3. MVP: upload → timeline → trim/split → ratio → export (browser prototype ✅; server upload, multi-track and the engine to come)
4. Subtitles (Hindi + English + Hinglish)
5. AI clips, silence cutter, auto-reframe
6. Motion, transitions, style presets, auto colour grading
7. Desktop build, performance pass, security review, deployment guide
