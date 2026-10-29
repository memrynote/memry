// Debug builds only: F12 toggles the web inspector, beside Tauri's own Cmd+Opt+I and
// Ctrl+Shift+I. A release build compiles no inspector and never adds this script.
;(() => {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'F12' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        return
      window.__TAURI_INTERNALS__.invoke('plugin:webview|internal_toggle_devtools').catch(() => {})
    },
    true
  )
})()
