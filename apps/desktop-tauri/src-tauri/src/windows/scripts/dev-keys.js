// Debug builds only, the developer keys of Electron's dev build: F12 toggles the web inspector,
// beside Tauri's own Cmd+Opt+I and Ctrl+Shift+I, and Cmd/Ctrl+R or F5 reloads the page. A release
// build compiles no inspector and never adds this script, so none of these keys does anything
// there.
;(() => {
  window.addEventListener(
    'keydown',
    (event) => {
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      const reload =
        (event.key === 'F5' && bare) ||
        (event.key.toLowerCase() === 'r' &&
          event.metaKey !== event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey)
      if (reload) {
        event.preventDefault()
        location.reload()
      } else if (event.key === 'F12' && bare) {
        window.__TAURI_INTERNALS__
          .invoke('plugin:webview|internal_toggle_devtools')
          .catch((error) => console.warn('[dev-keys] the inspector did not toggle', error))
      }
    },
    true
  )
})()
