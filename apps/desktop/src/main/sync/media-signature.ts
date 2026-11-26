import type { FileHandle } from 'fs/promises'

type Signature = (head: Buffer) => boolean

const bytesAt =
  (bytes: number[], at = 0): Signature =>
  (head) =>
    bytes.every((byte, i) => head[at + i] === byte)
const asciiAt =
  (text: string, at = 0): Signature =>
  (head) =>
    head.subarray(at, at + text.length).toString('latin1') === text
const anyOf =
  (...signatures: Signature[]): Signature =>
  (head) =>
    signatures.some((signature) => signature(head))
const riff =
  (form: string): Signature =>
  (h) =>
    asciiAt('RIFF')(h) && asciiAt(form, 8)(h)
const isoMedia = anyOf(
  ...['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].map((box) => asciiAt(box, 4))
)
const matroska = bytesAt([0x1a, 0x45, 0xdf, 0xa3])
const jpeg = bytesAt([0xff, 0xd8, 0xff])
const mpegFrame: Signature = (h) => h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0

/**
 * The leading bytes every file of each binary note type starts with. SVG is
 * text by design, so it has no entry and is never judged.
 */
const SIGNATURES: Record<string, Signature> = {
  png: bytesAt([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: jpeg,
  jpeg,
  gif: anyOf(asciiAt('GIF87a'), asciiAt('GIF89a')),
  webp: riff('WEBP'),
  // Readers accept the header anywhere in the first KiB.
  pdf: (h) => h.includes('%PDF-'),
  mp3: anyOf(asciiAt('ID3'), mpegFrame),
  wav: riff('WAVE'),
  ogg: asciiAt('OggS'),
  m4a: isoMedia,
  flac: asciiAt('fLaC'),
  aac: anyOf(asciiAt('ID3'), asciiAt('ADIF'), mpegFrame),
  mp4: isoMedia,
  webm: matroska,
  mov: isoMedia,
  avi: riff('AVI '),
  mkv: matroska
}

/** Whether files with this extension are judged at all. */
export function hasMediaSignature(extension: string): boolean {
  return extension.toLowerCase() in SIGNATURES
}

const HEAD_BYTES = 1024
/** Larger than any note body the write-back serialized; past it the file is not text we wrote. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Whether a media file holds text instead of media. Before #5414 the CRDT
 * write-back serialized a binary note's doc to markdown over its downloaded
 * image, PDF or recording (#5415). Such a file:
 *
 * - has an extension with a known signature (SVG and unknown types are never judged),
 * - does not start with that signature,
 * - is at most 16 MiB, has no NUL byte and decodes as strict UTF-8 (empty included).
 *
 * A file the user replaced with real media of any format fails the second or
 * third test, so it is never reported.
 */
export async function mediaFileHoldsText(
  file: FileHandle,
  extension: string,
  size: number
): Promise<boolean> {
  const signature = SIGNATURES[extension.toLowerCase()]
  if (!signature || size > MAX_TEXT_BYTES) return false
  const head = Buffer.alloc(Math.min(size, HEAD_BYTES))
  await file.read(head, 0, head.length, 0)
  if (signature(head)) return false
  const bytes = Buffer.alloc(size)
  await file.read(bytes, 0, size, 0)
  if (bytes.includes(0)) return false
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}
