// The Electron app's localStorage (`crate::migration::local_storage`). A key is set only when
// this origin has none, so state the renderer wrote since always wins. The marker key ends the
// import for this origin: the script stays attached for the webview's life and runs again on a
// reload or a crash recovery, which must not bring back a key the renderer deleted. Then the
// shell marks the file applied. A failure leaves it pending, and the next launch sets whatever
// is still missing. No key or value is logged.
;((markApplied) => {
  const entries = __MEMRY_ENTRIES__
  const imported = 'memry:electron-local-storage:imported'
  try {
    if (localStorage.getItem(imported) === null) {
      for (const [key, value] of Object.entries(entries)) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
      }
      localStorage.setItem(imported, '1')
    }
  } catch (error) {
    console.warn('[migration] localStorage import stopped:', error?.name)
    return
  }
  if (window.__TAURI_INTERNALS__) markApplied()
  else window.addEventListener('DOMContentLoaded', markApplied, { once: true })
})(() =>
  window.__TAURI_INTERNALS__
    .invoke('migration_localstorage_applied')
    .catch((error) => console.warn('[migration] localStorage not marked applied:', error))
)
