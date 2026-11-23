import { create } from 'zustand'
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { newDoc, type Doc } from './model'

enablePatches()

// Command pattern: every edit is recorded as forward + inverse patches, so undo is unlimited.
interface Entry { label: string; redo: Patch[]; undo: Patch[] }

interface State {
  doc: Doc
  past: Entry[]
  future: Entry[]
  run: (label: string, fn: (d: Doc) => void) => boolean
  undo: () => string | undefined
  redo: () => string | undefined
  reset: (doc: Doc) => void
}

export const useStore = create<State>((set, get) => ({
  doc: newDoc(),
  past: [],
  future: [],
  run(label, fn) {
    const [doc, redo, undo] = produceWithPatches(get().doc, fn)
    if (!redo.length) return false
    set((s) => ({ doc, past: [...s.past, { label, redo, undo }], future: [] }))
    return true
  },
  undo() {
    const e = get().past.at(-1)
    if (!e) return
    set((s) => ({ doc: applyPatches(s.doc, e.undo), past: s.past.slice(0, -1), future: [...s.future, e] }))
    return e.label
  },
  redo() {
    const e = get().future.at(-1)
    if (!e) return
    set((s) => ({ doc: applyPatches(s.doc, e.redo), future: s.future.slice(0, -1), past: [...s.past, e] }))
    return e.label
  },
  reset(doc) {
    set({ doc, past: [], future: [] })
  },
}))
