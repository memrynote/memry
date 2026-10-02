// JavaScriptCore on iOS has no URL, URLSearchParams, console or timers.
// Defuddle and linkedom need them, so the iOS bundle installs them first. This
// module must be imported before anything that touches those globals.
import { URL, URLSearchParams } from 'whatwg-url-minimum'

const scope = globalThis as Record<string, unknown>
if (typeof scope.URL === 'undefined') scope.URL = URL
if (typeof scope.URLSearchParams === 'undefined') scope.URLSearchParams = URLSearchParams
if (typeof scope.console === 'undefined') {
  const quiet = (): void => {}
  scope.console = { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet }
}
// Extraction is synchronous once `useAsync` is off; nothing should wait on a
// timer. A timer that never fires keeps a stray wait from crashing the run.
const timers: Record<string, () => number | void> = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {}
}
for (const [name, timer] of Object.entries(timers)) {
  if (typeof scope[name] === 'undefined') scope[name] = timer
}
