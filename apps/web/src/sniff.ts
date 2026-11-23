// Validate by magic bytes, never by extension.
export async function sniff(file: Blob): Promise<'mp4' | 'webm' | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (b.length < 12) return null
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp') return 'mp4' // MP4 / MOV
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm' // WebM / MKV (EBML)
  return null
}
