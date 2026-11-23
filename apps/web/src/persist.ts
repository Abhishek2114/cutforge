import type { Doc } from './model'

// Crash recovery: project JSON in localStorage on every edit, media files in the Origin Private File System.
const KEY = 'cutforge:doc'

export function saveDoc(d: Doc) {
  try { localStorage.setItem(KEY, JSON.stringify(d)) } catch { /* storage full or blocked: editing continues */ }
}

export function loadDoc(): Doc | null {
  try {
    const s = localStorage.getItem(KEY)
    return s ? (JSON.parse(s) as Doc) : null
  } catch {
    return null
  }
}

export async function saveFile(id: string, file: Blob) {
  const dir = await navigator.storage.getDirectory()
  const w = await (await dir.getFileHandle(id, { create: true })).createWritable()
  await file.stream().pipeTo(w)
}

export async function loadFile(id: string): Promise<File> {
  const dir = await navigator.storage.getDirectory()
  return (await dir.getFileHandle(id)).getFile()
}

export async function clearAll(ids: string[]) {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  const dir = await navigator.storage.getDirectory().catch(() => null)
  await Promise.all(ids.map((id) => dir?.removeEntry(id).catch(() => {})))
}
