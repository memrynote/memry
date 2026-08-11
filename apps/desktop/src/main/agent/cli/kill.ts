import type { ChildProcess } from 'node:child_process'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:Kill')

// How long a CLI gets to honour SIGTERM before it is killed outright.
//
// Derived from main's shutdown budget, not chosen for roundness: `before-quit`
// force-exits 5000ms in, `flushAllWindows()` alone can claim 2000ms of that, and
// killAll() runs at the very end of the chain (closeVault -> stopVaultAgentServices).
// That leaves the agent teardown ~1200ms, of which ~300ms must be reserved for the
// SIGKILL to land and 'exit' to propagate — so 900ms of SIGTERM grace. It also has
// to finish inside the 2000ms an abandoned turn child is given in runTurn's finally,
// otherwise that bounded wait expires and reports a survivor that was about to die.
//
// SIGKILL is not free: a CLI killed this way cannot flush its own state, close its
// MCP session cleanly, or reap tool subprocesses it spawned. 900ms is roughly three
// orders of magnitude more than either CLI needs to exit voluntarily, so a
// well-behaved backend never reaches the escalation at all.
export const KILL_ESCALATION_MS = 900

/** The slice of `ChildProcess` the kill closure touches, so tests can stub it honestly. */
export type EscalatableChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'> & {
  once(event: 'exit', listener: () => void): unknown
}

function hasExited(proc: EscalatableChild): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/**
 * Builds the `kill()` a tracked subprocess exposes: SIGTERM first, SIGKILL if the
 * child is still there afterwards. A CLI that traps SIGTERM — or that is wedged in
 * a tool call — otherwise absorbs the signal and keeps running as a live orphan
 * after cancel, and past quit once main exits and it is reparented to init.
 */
export function createEscalatingKill(proc: EscalatableChild): () => void {
  let escalation: ReturnType<typeof setTimeout> | undefined
  proc.once('exit', () => {
    if (escalation) clearTimeout(escalation)
    escalation = undefined
  })

  return () => {
    if (hasExited(proc)) return

    // Armed before the SIGTERM is sent: `kill()` can throw (EPERM), and callers
    // treat that as "this child is unreachable" and move on. Arming first means
    // even that path still gets an escalation attempt.
    if (!escalation) {
      escalation = setTimeout(() => {
        escalation = undefined
        if (hasExited(proc)) return
        logger.warn('Agent CLI ignored SIGTERM; escalating to SIGKILL', { pid: proc.pid })
        try {
          proc.kill('SIGKILL')
        } catch (error) {
          logger.warn('Failed to SIGKILL agent CLI', { pid: proc.pid, error })
        }
      }, KILL_ESCALATION_MS)
    }

    proc.kill('SIGTERM')
  }
}
