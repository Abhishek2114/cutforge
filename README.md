# CutForge

[![ci](https://github.com/Abhishek2114/cutforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Abhishek2114/cutforge/actions/workflows/ci.yml)

A Hindi-first, non-destructive video editor for Indian creators, built as a web app and a desktop app (Tauri) from one codebase. The wedge: accurate Hindi/Hinglish/English subtitles with correct Devanagari rendering, one-click reels, auto colour grading, an auto silence cutter, and smooth editing on mid-range laptops and phones.

**Status:** Deliverable 1 of 7 (architecture, data model, project schema, API spec, risks).

## Contents

| File | What it is |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, render pipeline, AI pipelines, sync/autosave, security, performance, testing, **legal & licensing review**, ranked risks |
| [docs/data-model.sql](docs/data-model.sql) | Postgres 16 schema (users, assets, projects + op log + versions, jobs, transcripts, clip library, dictionary, billing, RLS) |
| [packages/project-schema/project.schema.json](packages/project-schema/project.schema.json) | JSON Schema for the project document (EDL) |
| [packages/project-schema/examples/](packages/project-schema/examples/) | Example projects: a Hindi vlog with a 9:16 reel, karaoke captions, auto grade and silence cuts; a minimal new project |
| [docs/api.yaml](docs/api.yaml) | REST API, OpenAPI 3.1 (36 endpoints) |

## Brief coverage

The brief asks for 7 deliverables, with a stop for approval after each. This repo is **Deliverable 1**. Every feature in the brief is designed here; code for the features arrives in Deliverables 3–7. `§` refers to sections of [architecture.md](docs/architecture.md).

| Brief requirement | Where it is answered | Status |
|---|---|---|
| ≤ 5 clarifying questions before starting | §0 (hosting, translation engine, collaboration, codec licensing) | Done |
| 1. Upload: tus, magic bytes, proxies, thumbs, waveform | §6 · API `/v1/assets` · `assets` table | Designed |
| 2. Sequence: multi-track, trim/split/ripple, unlimited undo | §1 Bet 3, §4 · schema `sequence/tracks/items` | Designed |
| 3. Ratio presets, Fit/Fill/Blur, auto-reframe | §5 step 4, §7 · schema `clip.reframe` per aspect · API `reframe` job | Designed |
| 4. Motion, transitions, keyframes, speed ramps | §5 steps 1, 5 · schema `transition`, `keyframe`, `speed` | Designed |
| 4. Auto colour grading, match, log, LUT, skin protection, parity | §5 step 3 (one 3D LUT per clip) + golden-frame contract, §7 · schema `grade`, `look` | Designed |
| 5. Hindi/English/Hinglish subtitles, translate, transliterate, fix pass | §7 · API `transcribe/translate/transliterate/fix_subtitles` · `transcripts`, `dictionary_entries` | Designed |
| 5. Devanagari rendering (HarfBuzz, libass, Noto/Mukta/Poppins) | §5 step 7 · schema `textStyle/captionStyle` (bundled fonts only) | Designed |
| 5. Subtitles stay in sync after edits | §1 Bet 2: captions stored in source time | Designed |
| 6. Highlights, make 5 reels, clip library | §7 · API `highlights` · `library_clips` | Designed |
| 6. Auto silence cutter: VAD, controls, modes, review, smoothing, fillers | §7 · schema `cutSets` (editable regions, accept/reject) | Designed |
| 7. Export: formats, presets, queue, resume, notifications | §8 · API `export` job, `/v1/events` | Designed |
| Non-destructive versioned JSON + migrations | §9 · [project.schema.json](packages/project-schema/project.schema.json) | **Built + tested** |
| Autosave, crash recovery, offline | §9 | Designed |
| Performance, low-end mode, accessibility, Hindi UI | §13, §14 | Designed |
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

To run check 1 locally:
```bash
python3 packages/project-schema/check_schema.py
```

## Roadmap

1. Architecture, data model, schema, API ✅
2. Monorepo scaffold + CI
3. MVP: upload → timeline → trim/split → ratio → export
4. Subtitles (Hindi + English + Hinglish)
5. AI clips, silence cutter, auto-reframe
6. Motion, transitions, style presets, auto colour grading
7. Desktop build, performance pass, security review, deployment guide
