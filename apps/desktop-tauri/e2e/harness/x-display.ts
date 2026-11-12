import { type ChildProcess, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

import { HarnessError } from './errors.ts'
import { parkPointer } from './park-pointer.ts'

/**
 * Set to 1 by the Linux CI step: every app gets an Xvfb of its own, with the focus a window
 * manager gives (#3967). Unset, apps share the display the run started on.
 */
export const DISPLAY_PER_APP_ENV = 'MEMRY_E2E_DISPLAY_PER_APP'

/**
 * Gives the window of a bare Xvfb the X input focus, as a window manager does when it maps one.
 * Without it no window is ever the focus window, GTK never marks the toplevel active and
 * `document.hasFocus()` stays false. WebKitGTK then collapses a `contenteditable` selection
 * 0.25 to 1.5 s after it is set, with no app code involved (a bare `<div contenteditable>`
 * collapsed 196 of 240 runs), which flaked `wiki-heading-links` "Linking selected text" (#3967).
 * Focus belongs to the whole X server, which is why each app has its own display. Override-redirect
 * windows (menus, tooltips) are skipped, as they are by a window manager. Ends when the display does.
 */
const FOCUS_SCRIPT = `
import ctypes
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x.XQueryTree.argtypes = [ctypes.c_void_p] + [ctypes.c_void_p] * 5
x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
x.XFlush.argtypes = [ctypes.c_void_p]

class MapEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('event', ctypes.c_ulong), ('window', ctypes.c_ulong),
                ('override_redirect', ctypes.c_int)]

class Event(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('map', MapEvent), ('pad', ctypes.c_long * 24)]

# A window that is not viewable yet answers XSetInputFocus with BadMatch; ignore it.
ignore = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda d, e: 0)
x.XSetErrorHandler(ignore)

display = x.XOpenDisplay(None)
if not display:
    raise SystemExit('cannot open the X display')
root = x.XDefaultRootWindow(display)
SUBSTRUCTURE_NOTIFY = 1 << 19
MAP_NOTIFY = 19
REVERT_TO_POINTER_ROOT = 1
CURRENT_TIME = 0

x.XSelectInput(display, root, SUBSTRUCTURE_NOTIFY)
unused = ctypes.c_ulong()
children = ctypes.POINTER(ctypes.c_ulong)()
count = ctypes.c_uint()
x.XQueryTree(display, root, ctypes.byref(unused), ctypes.byref(unused), ctypes.byref(children), ctypes.byref(count))
for i in range(count.value):
    x.XSetInputFocus(display, children[i], REVERT_TO_POINTER_ROOT, CURRENT_TIME)
x.XFlush(display)
print('ready', flush=True)

event = Event()
while True:
    x.XNextEvent(display, ctypes.byref(event))
    if event.type == MAP_NOTIFY and not event.map.override_redirect:
        x.XSetInputFocus(display, event.map.window, REVERT_TO_POINTER_ROOT, CURRENT_TIME)
        x.XFlush(display)
`

const children = new Set<ChildProcess>()

process.once('exit', () => {
  for (const child of children) child.kill('SIGKILL')
})

function track(child: ChildProcess): void {
  children.add(child)
  child.once('exit', () => children.delete(child))
}

/** Resolves with the first line a child writes to `stream`, or rejects when it ends without one. */
function firstLine(
  child: ChildProcess,
  stream: Readable | null | undefined,
  what: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    stream?.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const end = text.indexOf('\n')
      if (end >= 0) resolve(text.slice(0, end).trim())
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      reject(new HarnessError(`${what} exited before it was ready (code=${code} signal=${signal})`))
    )
  })
}

export interface AppDisplay {
  /** The `DISPLAY` value of the new server, such as `:101`. */
  display: string
  /** Ends the focus keeper and the server. */
  stop(): void
}

/**
 * Starts an Xvfb that picks its own free display number (`-displayfd`), parks its pointer off the
 * app windows and gives its windows the input focus. `-noreset` keeps the server up when its
 * last client disconnects, so an app connecting at that moment is not cut off (#3947).
 * `output` is a file descriptor that takes the server's stderr.
 */
export async function startAppDisplay(output: number): Promise<AppDisplay> {
  const server = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-noreset', '-nolisten', 'tcp'],
    { stdio: ['ignore', output, output, 'pipe'] }
  )
  track(server)
  let keeper: ChildProcess | undefined
  const stop = (): void => {
    keeper?.kill('SIGKILL')
    server.kill('SIGKILL')
  }
  try {
    const display = `:${await firstLine(server, server.stdio[3] as Readable, 'Xvfb')}`
    parkPointer(display)
    keeper = spawn('python3', ['-c', FOCUS_SCRIPT], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', 'pipe', output]
    })
    track(keeper)
    await firstLine(keeper, keeper.stdout, 'the focus keeper')
    return { display, stop }
  } catch (error) {
    stop()
    throw error
  }
}
