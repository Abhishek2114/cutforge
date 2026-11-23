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
