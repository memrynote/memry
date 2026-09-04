import type { GuestPaintMark } from '@memry/contracts/webview-bridge'

/**
 * Guest half of the note-open trace (#2043).
 *
 * The #2026 baseline put 3390 ms of a 3876 ms open inside ONE interval — the
 * guest sends `ready`, and 3.4 s later the document is on screen — and nothing
 * inside that interval was observable from the host. These marks split it.
 * They ride out on the `painted` message the guest already flushes, so there is
 * no second channel and no second timeline; `open-trace.ts` folds them into the
 * same phase table the host phases render in.
 *
 * THIS MODULE MUST BE THE ENTRY'S FIRST IMPORT, and it must stay free of value
 * imports. ES modules evaluate depth-first in source order, so a mark taken in
 * a leaf module with no dependencies is the earliest timestamp the bundle can
 * take — which is what makes `importsStart` → `scriptEval` mean "the dependency
 * graph evaluating" rather than "some of it". One value import here (zod, by
 * way of the contract module) would move the mark behind that import and quietly
 * shrink the interval it exists to expose. Hence `import type`, which erases.
 */

const marks: Partial<Record<GuestPaintMark, number>> = {}

export function markGuest(mark: GuestPaintMark): void {
  marks[mark] = Date.now()
}

/**
 * Marks taken before `doc-load` names the open they belong to.
 *
 * Only the early probe: the host queues it immediately AHEAD of `doc-load`
 * precisely so it is timed before the open begins (`HostProbeSchema`), so
 * clearing it here would erase the one mark the probe experiment exists for.
 */
const PRE_OPEN_MARKS: readonly GuestPaintMark[] = ['probeEarlyRecv']

let opens = 0

/**
 * Start a new open's marks (#2030).
 *
 * This document now outlives the note it is showing, so the mark record has to
 * be told where one open ends and the next begins. Without it the second and
 * every later open would report the FIRST open's boot stamps, and the report
 * would print a fabricated open that took almost no time at all.
 *
 * The first open keeps everything: the WebView booted for it, so `docStart`
 * through `readySent` are honestly part of it. From the second on the record
 * starts empty, which leaves the boot marks ABSENT rather than stale — and an
 * absent phase is a phase with no samples, not a phase that took 0 ms.
 */
export function beginOpenMarks(): void {
  if (opens++ === 0) return
  for (const key of Object.keys(marks) as GuestPaintMark[]) {
    if (PRE_OPEN_MARKS.includes(key)) continue
    delete marks[key]
  }
}

/** A copy, so a mark taken after the send cannot mutate a message in flight. */
export function guestMarks(): Partial<Record<GuestPaintMark, number>> {
  return { ...marks }
}

marks.importsStart = Date.now()
// The document's navigation start, in the same epoch every other mark uses.
// `performance.now()` counts from `timeOrigin`, so subtracting it recovers that
// origin — and that is what places the WebView's own startup on the host's
// timeline instead of leaving it as an unattributed gap.
marks.docStart = Math.round(marks.importsStart - performance.now())
