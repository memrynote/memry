/**
 * While an IME composes text (Korean, Japanese, Chinese, Vietnamese Telex,
 * Hindi transliteration, and so on), Enter commits the pending syllable and
 * Escape cancels it. Those keys belong to the IME. Chromium still dispatches
 * their keydown, marked `isComposing` or with `keyCode` 229, and a text field
 * that submits or blurs on it acts before the syllable lands: a Korean title
 * typed as `이것은 제목입니다` saved as `다New note` (#5571).
 *
 * One window capture listener runs before every React and document handler and
 * stops those keydowns on `<input>` and `<textarea>`, so no field handler needs
 * its own check. A Korean IME follows the commit with a plain Enter, which the
 * field then handles with the full text. Contenteditable editors (ProseMirror,
 * CodeMirror) still get the events: they track composition themselves.
 */
function onKeyDown(event: KeyboardEvent): void {
  // oxlint-disable-next-line typescript/no-deprecated -- keyCode 229 also marks IME keydowns that carry isComposing false: the one that starts a composition, and in WebKit the one that commits it
  if (!event.isComposing && event.keyCode !== 229) return
  const field = event.target
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return
  event.stopImmediatePropagation()
}

export function installImeCompositionGuard(target: Window): () => void {
  target.addEventListener('keydown', onKeyDown, { capture: true })
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true })
}
