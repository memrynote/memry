/**
 * Shared stub for package scripts whose implementation is deferred to a
 * future milestone. Exits non-zero with a clear message so accidental
 * invocations fail loudly instead of silently passing.
 */

export function notYetImplemented(
  scriptName: string,
  milestone: string,
  purpose: string
): never {
  process.stderr.write(
    `\n${scriptName}: not yet implemented.\n` +
      `  Planned for: ${milestone}\n` +
      `  Purpose:     ${purpose}\n` +
      `  See: docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md\n\n`
  )
  process.exit(2)
}
