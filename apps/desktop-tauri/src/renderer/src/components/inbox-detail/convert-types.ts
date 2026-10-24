/**
 * Shared types/constants for inbox-detail type conversion.
 *
 * Kept in its own module so the panel can read NOTE_ONLY_TYPES while tests
 * still mock `./convert-actions` (which otherwise owns it).
 */

export type ConvertType = 'note' | 'task' | 'event' | 'reminder'

// Items with no usable text body: they can only become a plain note. Mirrors
// isNoteOnlyType in the main process (voice is excluded — transcription is text).
export const NOTE_ONLY_TYPES = ['image', 'pdf', 'video', 'clip']

export function isNoteOnlyType(type: string): boolean {
  return NOTE_ONLY_TYPES.includes(type)
}
