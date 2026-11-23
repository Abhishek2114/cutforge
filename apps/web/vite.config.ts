import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // BASE_PATH lets the same build serve from a sub-path (e.g. GitHub Pages /cutforge/).
  base: process.env.BASE_PATH ?? '/',
  // Silero VAD is tiny: the CPU-only ONNX runtime (15 MB wasm) is enough; the default build also pulls the 29 MB WebGPU one.
  resolve: { alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' }] },
})
