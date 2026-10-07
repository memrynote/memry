/**
 * Sets `<html data-platform>` before the first frame. The title row's CSS keys
 * off it: only macOS draws its traffic lights inside that row, so only there do
 * the window-control buttons start after them (main.css).
 */
export function applyStartupPlatform(platform: NodeJS.Platform): void {
  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    root.setAttribute('data-platform', platform)
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener('DOMContentLoaded', () => void applyToRoot(), { once: true })
  }
}
