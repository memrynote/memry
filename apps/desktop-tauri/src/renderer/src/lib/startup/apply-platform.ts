import { readStartupState } from './state'

// A page opened outside the app window has no startup state; the user agent is the only hint.
function platformFromUserAgent(): string {
  const agent = navigator.userAgent
  if (agent.includes('Mac')) return 'darwin'
  if (agent.includes('Windows')) return 'win32'
  return 'linux'
}

/**
 * Sets `<html data-platform>` before the first frame. The title row's CSS keys off it: only
 * macOS draws its traffic lights inside that row (main.css).
 */
export function applyStartupPlatform(): void {
  const platform = readStartupState()?.platform ?? platformFromUserAgent()

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
