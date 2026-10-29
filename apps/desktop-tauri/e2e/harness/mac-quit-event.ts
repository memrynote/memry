import { spawnSync } from 'node:child_process'

// What loginwindow sends at Log Out, Restart and Shut Down: `aevt`/`quit` with the quit reason
// `rlgo` (kAEReallyLogOut), `rest` or `shut`, sent to the pid through the Apple Event Manager, as
// a JXA script (the e2e build is no bundle, so `quit app` cannot name it). Dock Quit and
// `quit app` send the same event without a reason. A refused quit answers userCanceledErr (-128),
// which loginwindow reads as a cancelled logout.
const SEND_QUIT_EVENT = `function run([pid, reason]) {
  ObjC.import('Foundation')
  const code = (s) => s.split('').reduce((n, c) => n * 256 + c.charCodeAt(0), 0)
  const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(Number(pid))
  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(code('aevt'), code('quit'), target, -1, 0)
  event.setAttributeDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithTypeCode(code(reason)), code('why?'))
  const error = Ref()
  const reply = event.sendEventWithOptionsTimeoutError(3, 30, error)
  if (reply.isNil()) return 'error ' + error[0].code
  const errn = reply.paramDescriptorForKeyword(code('errn'))
  return 'errn ' + (errn.isNil() ? 0 : errn.int32Value)
}`

/**
 * Sends the quit Apple event with `reason` to `pid` and waits for the reply: `errn 0` when the
 * app accepted the quit, `errn -128` when it refused, `error <code>` when no reply came, and
 * osascript's error when the script failed.
 */
export function sendQuitEvent(pid: number, reason: 'rlgo' | 'rest' | 'shut'): string {
  const reply = spawnSync(
    'osascript',
    ['-l', 'JavaScript', '-e', SEND_QUIT_EVENT, String(pid), reason],
    {
      encoding: 'utf8',
      timeout: 15_000
    }
  )
  return reply.stdout.trim() || reply.stderr.trim()
}
