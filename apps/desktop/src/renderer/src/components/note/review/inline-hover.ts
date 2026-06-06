export function syncInlineHoverClass(id: string | null): void {
  document
    .querySelectorAll<HTMLElement>('[data-critic-mark-kind][data-critic-mark-id]')
    .forEach((element) => {
      element.classList.toggle(
        'critic-mark-hovered',
        id !== null && element.dataset.criticMarkId === id
      )
    })

  const styleId = 'critic-mark-hover-style'
  let style = document.getElementById(styleId) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = styleId
    document.head.appendChild(style)
  }

  if (!id) {
    style.textContent = ''
    return
  }

  const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  style.textContent = `[data-critic-mark-kind][data-critic-mark-id="${escapedId}"] { background: color-mix(in srgb, var(--accent-orange) 30%, transparent) !important; }`
}
