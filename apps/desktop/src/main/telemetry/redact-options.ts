// The main process's redaction config, shared by anything that scrubs free-form
// text before it leaves the device. It is deliberately the SAME salted-hash
// setup Path A log shipping installs (see log-ship.ts), so an error message and
// a shipped log line collapse the same vault path and hash the same note title
// to the same placeholder — otherwise the two halves of an incident cannot be
// joined during triage.
import type { RedactOptions } from '@memry/contracts/redact'

import { getCurrentVaultPath } from '../store'
import { getOrCreateDiagnosticsSalt, makeSaltedHasher } from './diagnostics-salt'

let hasher: ((value: string) => string) | null = null

/**
 * Never throws: reading/creating the salt touches the telemetry config file, and
 * every caller is an error path, so a failure here would destroy the very report
 * being built. It degrades to mask mode (fixed `<email>`/`<id>` placeholders, no
 * correlation) instead — still fully redacted, just less useful during triage.
 * Deliberately silent: the config module logs its own read/write failures, and
 * logging from here would re-enter the diagnostics path that called it.
 */
export const getMainRedactOptions = (): RedactOptions => {
  try {
    hasher ??= makeSaltedHasher(getOrCreateDiagnosticsSalt())
    return { vaultRoot: getCurrentVaultPath() ?? undefined, hash: hasher }
  } catch {
    return {}
  }
}
