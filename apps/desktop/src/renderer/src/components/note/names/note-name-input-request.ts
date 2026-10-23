const EVENT = 'memry:note-name-input'

export function requestNoteNameInput(noteId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: noteId }))
}

export function onNoteNameInputRequest(noteId: string, open: () => void): () => void {
  const listener = (event: Event): void => {
    if ((event as CustomEvent<string>).detail === noteId) open()
  }
  window.addEventListener(EVENT, listener)
  return () => {
    window.removeEventListener(EVENT, listener)
  }
}
