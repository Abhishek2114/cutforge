// Self-host the Silero VAD model and ONNX runtime so Auto edit works offline and loads nothing from third parties.
import { cpSync, mkdirSync } from 'node:fs'

const out = new URL('../public/vad/', import.meta.url)
mkdirSync(out, { recursive: true })
for (const f of [
  '@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
]) cpSync(new URL(`../node_modules/${f}`, import.meta.url), new URL(f.split('/').pop(), out))
