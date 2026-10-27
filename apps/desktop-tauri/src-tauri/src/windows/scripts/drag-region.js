// Window dragging from `.drag-region`. Capture phase, so a page handler cannot swallow it, and
// a real `mousedown`, which Wayland needs to start a move. `plugin:window|start_dragging`
// posts the native caption drag, so Aero Snap and restore-from-maximize work.
;(() => {
  const INTERACTIVE =
    '.no-drag, a, button, input, textarea, select, [role=button], [contenteditable]'
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- an init script wraps everything in one function so it adds no globals
  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command).catch(() => {})
  const onDragRegion = (event) =>
    event.button === 0 &&
    event.target instanceof Element &&
    !event.target.closest(INTERACTIVE) &&
    event.target.closest('.drag-region') !== null
  window.addEventListener(
    'mousedown',
    (event) => {
      if (event.detail === 1 && onDragRegion(event)) invoke('plugin:window|start_dragging')
    },
    true
  )
  window.addEventListener(
    'dblclick',
    (event) => {
      if (!onDragRegion(event)) return
      const shell = window.__MEMRY_SHELL__
      if (shell?.maximizable === false) return
      invoke('plugin:window|toggle_maximize')
    },
    true
  )
})()
