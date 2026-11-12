import { execFileSync } from 'node:child_process'

import { HarnessError } from './errors'

// Moves the pointer to the screen's bottom-right pixel through libX11 (ctypes), where no app
// window reaches: the harness places windows at 0,0 at 1440x900, and the default rect is centred.
const X11_PARK_SCRIPT = `
import ctypes
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
display = ctypes.c_void_p(x.XOpenDisplay(None))
if not display.value:
    raise SystemExit('cannot open the X display')
screen = x.XDefaultScreen(display)
x.XDefaultRootWindow.restype = ctypes.c_ulong
root = ctypes.c_ulong(x.XDefaultRootWindow(display))
width = x.XDisplayWidth(display, screen)
height = x.XDisplayHeight(display, screen)
x.XWarpPointer(display, 0, root, 0, 0, 0, 0, width - 1, height - 1)
x.XFlush(display)
x.XCloseDisplay(display)
print(f'{width - 1},{height - 1}')
`

// The Windows runner's screen is 1024x768, smaller than the 1440x900 app windows, so no pixel is
// clear of the windows. Column 0 is clear of their pages: a window placed at 0,0 keeps an 8 px
// resize border at its left edge, and its page starts at screen x 8 (`window.screenX` on CI).
const WINDOWS_PARK_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$at = New-Object System.Drawing.Point($screen.Left, ($screen.Bottom - 1))
[System.Windows.Forms.Cursor]::Position = $at
$now = [System.Windows.Forms.Cursor]::Position
if ($now -ne $at) { throw "the cursor is at $($now.X),$($now.Y), not $($at.X),$($at.Y)" }
"$($at.X),$($at.Y) on a $($screen.Width)x$($screen.Height) screen"
`

function park(): string | null {
  if (process.platform === 'linux' && process.env.DISPLAY) {
    return execFileSync('python3', ['-c', X11_PARK_SCRIPT], { encoding: 'utf8' })
  }
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PARK_SCRIPT],
      { encoding: 'utf8' }
    )
  }
  return null
}

/**
 * Parks the OS pointer off every app page, once per run. Specs drive input through WebDriver
 * only, but a real pointer resting over a window reaches the page as trusted mouse moves and
 * `pointerover`s whenever content moves under it.
 * - Xvfb starts the pointer at the screen centre. With it over the Settings scroll area, the area
 *   sometimes scrolled itself up in 36 px steps right after a click target was scrolled into view,
 *   and the click landed on the row above (#3967).
 * - The Windows runner starts it at the screen centre too. A table inserted above it moved the
 *   editor's trailing block under it, and that trusted `pointerover` could land after the spec's
 *   hover and take the table's handles down (`table-border-handles.e2e.ts`, #3967).
 * Elsewhere (macOS) this does nothing.
 */
export function parkPointer(): void {
  try {
    const at = park()
    if (at !== null) console.log(`[e2e] parked the pointer at ${at.trim()}`)
  } catch (error) {
    throw new HarnessError(`could not park the pointer off the app windows: ${String(error)}`)
  }
}
