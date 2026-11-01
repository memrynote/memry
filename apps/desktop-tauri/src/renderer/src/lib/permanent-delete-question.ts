/**
 * The questions a note delete asks when the OS trash refuses the note's file (#3813), in the
 * order they were asked; `PermanentDeleteConfirm` shows the first.
 *
 * @module lib/permanent-delete-question
 */

export interface Question {
  title: string
  answer: (permanent: boolean) => void
}

const questions: Question[] = []
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const current = (): Question | null => questions[0] ?? null

/** Resolves true when the user chose to delete the note `title` for good. */
export function askPermanentDelete(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    questions.push({ title, answer: resolve })
    if (questions.length === 1) changed()
  })
}

/**
 * Answers `question` once: a button and the close it causes both answer, and only the first
 * reaches the question; the next one in line is not answered for it.
 */
export function answer(question: Question | null, permanent: boolean): void {
  if (!question || questions[0] !== question) return
  questions.shift()
  question.answer(permanent)
  changed()
}
