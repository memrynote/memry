import { execFileSync } from 'node:child_process'

import { HarnessError } from './errors'

// Moves the pointer to the screen's bottom-right pixel through libX11 (ctypes), where no app
// window reaches: the harness places windows at 0,0 at 1440x900, and the default rect is centred.
const PARK_SCRIPT = `
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

/**
 * Parks the X pointer off every app window, once per run. Specs drive input through WebDriver
 * only; Xvfb starts the pointer at the screen centre, over the app windows, and WebKitGTK feeds
 * it to the page as real mouse moves whenever content moves under it. With the pointer resting
 * over the Settings scroll area, the area sometimes scrolled itself up in 36 px steps right after
 * a click target was scrolled into view, and the click landed on the row above (#3967). Only an
 * X11 display (CI's Xvfb) has the pointer; elsewhere this does nothing.
 */
export function parkPointer(): void {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return
  try {
    const at = execFileSync('python3', ['-c', PARK_SCRIPT], { encoding: 'utf8' }).trim()
    console.log(`[e2e] parked the X pointer at ${at}`)
  } catch (error) {
    throw new HarnessError(`could not park the X pointer off the app windows: ${String(error)}`)
  }
}
