import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

import { startAppDisplay } from './x-display.ts'

const GTK_WINDOW = `
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
win = Gtk.Window()
def active(window, _):
    if window.is_active():
        print('active', flush=True)
        Gtk.main_quit()
win.connect('notify::is-active', active)
win.show_all()
Gtk.main()
`

const have = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0
const canRun =
  process.platform === 'linux' &&
  have('which', ['Xvfb']) &&
  have('python3', ['-c', "import gi; gi.require_version('Gtk', '3.0')"])

// Without a window manager nothing gives a window the X input focus, GTK never marks its toplevel
// active, and WebKitGTK collapses the selection in a `contenteditable` (#3967).
test(
  'a window that opens on an app display becomes the active window',
  { skip: !canRun && 'needs Linux with Xvfb and python3-gi', timeout: 30_000 },
  async (t) => {
    const screen = await startAppDisplay(2)
    t.after(screen.stop)
    const window = spawn('python3', ['-c', GTK_WINDOW], {
      env: { ...process.env, DISPLAY: screen.display },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    t.after(() => window.kill('SIGKILL'))
    let out = ''
    window.stdout.on('data', (chunk) => (out += chunk))
    await once(window, 'exit')
    assert.equal(out.trim(), 'active')
  }
)
