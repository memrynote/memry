// The renderer's `window.api` as ported specs see it. The Electron preload declaration is
// large and domain steps replace it call by call; specs reach it through `page.evaluate`.
// A global script (no import or export), so the declaration merges into `Window` everywhere.
interface Window {
  api: any
  /** Published by the Rust init script before first paint (`StartupState`). */
  __MEMRY_STARTUP__?: { theme: string; locale: string; direction: string }
}
