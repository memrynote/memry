/**
 * The per-edit oracle of the journal fleet simulator (#5508, chapter 06
 * §6.12). A run loses a write when the write was a latest write to its unit
 * (no other write to the unit causally follows it), the run ends on another
 * value, and the document rule (§6.3.1, every device on the build before
 * #5508) replayed on the same steps ends on that very write. Matching the
 * write by its step, not its value, keeps an edit that is a no-op in one
 * history and a real write in the other from reading as a loss.
 *
 * Each loss is classed by the pull that dropped it: one that held it, or
 * pulled a record that held it, and ended on another value. A new build's
 * merge that followed a claim already covering the write only carries an
 * earlier drop on, so the earlier drop classes the loss:
 * - `a`: a new build's merge replaced it with a value only older writes
 *   produced (a stale revert), although one side of the merge held a claim
 *   on the unit. The rule had the evidence and chose wrong. Never allowed.
 * - `b`: excused. The run keeps a concurrent write the document rule drops,
 *   or a new build's merge chose another latest write over it.
 * - `c`: an older build dropped it inside a whole apply. Older builds keep
 *   today's whole-record behaviour (Kaan, 2026-11-25), so it is allowed.
 * - `d`: a new build's merge reverted it with no claim on either side: both
 *   sides' only evidence on the unit is a whole-record floor, and the floors
 *   are concurrent. The document rule takes the remote here too; it kept the
 *   write only because of the order its re-queued pushes landed in.
 * A loss no pull explains classes as `a`, so the oracle fails closed.
 */
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { valuesEqual } from '../field-merge'
import type { JournalFields } from '../journal-merge'
import { compare } from '../vector-clock'
import { Rule, type Kind } from './fleet'
import { converged, run, valueOf, violations, type Drop, type Scenario, type Write } from './run'

export type LossClass = 'a' | 'b' | 'c' | 'd'

export interface Judgement {
  /** The worst class over the run's losses; `null` with none. */
  loss: LossClass | null
  lost: Write[]
  diverged: boolean
  livelock: boolean
  /** The document rule's own replay diverged: a broken harness. */
  refDiverged: boolean
}

const OLDER: ReadonlySet<Kind> = new Set(['oldDesk', 'oldCore'])
const SEVERITY: LossClass[] = ['b', 'c', 'd', 'a']

const worst = (classes: LossClass[]): LossClass | null =>
  classes.reduce<LossClass | null>(
    (out, next) => (out === null || SEVERITY.indexOf(next) > SEVERITY.indexOf(out) ? next : out),
    null
  )

const covers = (clock: VectorClock, write: VectorClock): boolean => {
  const order = compare(write, clock)
  return order === 'before' || order === 'equal'
}

/** Writes to `unit` no other write to it causally follows. */
function latest(writes: Write[], unit: string): Write[] {
  const on = writes.filter((write) => write.unit === unit)
  return on.filter((write) => !on.some((other) => compare(write.clock, other.clock) === 'before'))
}

/**
 * §6.12.1 re-derived from the payloads: the clock `side` claims `unit` at
 * against `other`. A trusted side's stamped write, else its unit floor where
 * the floor strictly dominates the other side's evidence or there is none.
 */
function claim(side: JournalFields, other: JournalFields, unit: string): VectorClock | undefined {
  const evidence = (s: JournalFields): { write?: VectorClock; floor?: VectorClock } => {
    const trusted =
      s.fieldClocks !== undefined &&
      s.fieldClocksAt !== undefined &&
      valuesEqual(s.fieldClocksAt, s.clock ?? {})
    if (!trusted) return { floor: s.clock ?? {} }
    const clocks: FieldClocks = s.fieldClocks ?? {}
    return { write: clocks[unit], floor: s.fieldFloors?.[unit] ?? s.fieldClocksFloor }
  }
  const mine = evidence(side)
  if (mine.write !== undefined) return mine.write
  const theirs = evidence(other)
  const against = theirs.write ?? theirs.floor
  if (mine.floor === undefined) return undefined
  return against === undefined || compare(against, mine.floor) === 'before' ? mine.floor : undefined
}

/** The class of the pull `drop` that dropped `write`; `null` when it is not the cause. */
function classOfDrop(drop: Drop, write: Write, writes: Write[]): LossClass | null {
  const held = drop.from === write.value && covers(drop.seen, write.clock)
  const pulled = drop.incoming === write.value && covers(drop.remote, write.clock)
  if (drop.to === write.value || (!held && !pulled)) return null
  if (OLDER.has(drop.kind)) return 'c'
  // A new build applying a dominating record: its writer dropped the write first.
  if (drop.action !== 'merge') return null
  const stale = !writes.some(
    (other) =>
      other.unit === write.unit &&
      other.value === drop.to &&
      other.step !== write.step &&
      !covers(write.clock, other.clock)
  )
  if (!stale) return 'b'
  if (drop.call === undefined) return 'a'
  const { local, remote } = drop.call
  const localClaim = claim(local, remote, write.unit)
  const remoteClaim = claim(remote, local, write.unit)
  const won = valueOf(local, write.unit) === drop.to ? localClaim : remoteClaim
  if (won !== undefined && covers(won, write.clock)) return null
  return localClaim !== undefined || remoteClaim !== undefined ? 'a' : 'd'
}

/** Runs `scenario` on the new rule and the document rule, and classes its losses. */
export function judge(scenario: Scenario): Judgement {
  const out = run(scenario, new Rule(true))
  const ref = run(scenario, new Rule(), true)
  const judgement = {
    diverged: !converged(out),
    livelock: out.livelock,
    refDiverged: !converged(ref) || ref.livelock
  }
  const final = (unit: string): string => valueOf(out.server, unit)
  const refFinal = (unit: string): string => valueOf(ref.server, unit)
  const outBad = new Set(violations(out).map((violation) => violation.unit))
  const refBad = new Set(violations(ref).map((violation) => violation.unit))
  const refKeeps = (write: Write): boolean =>
    latest(ref.writes, write.unit).some(
      (kept) => kept.step === write.step && kept.value === refFinal(write.unit)
    )
  const lost = [...outBad].flatMap((unit) =>
    latest(out.writes, unit).filter((write) => write.value !== final(unit) && refKeeps(write))
  )
  if (lost.length === 0) return { loss: null, lost, ...judgement }

  // A loss is excused by a concurrent write the run keeps and the document rule drops.
  const keptDropped: Write[] = []
  for (const unit of refBad) {
    if (outBad.has(unit)) continue
    const dropped = new Set(
      latest(ref.writes, unit)
        .filter((write) => write.value !== refFinal(unit))
        .map((write) => write.step)
    )
    for (const write of latest(out.writes, unit)) {
      if (dropped.has(write.step) && write.value === final(unit)) keptDropped.push(write)
    }
  }
  const classes = lost.map((write): LossClass => {
    if (keptDropped.some((kept) => compare(kept.clock, write.clock) === 'concurrent')) return 'b'
    const causes = out.drops
      .filter((drop) => drop.unit === write.unit)
      .map((drop) => classOfDrop(drop, write, out.writes))
      .filter((cls): cls is LossClass => cls !== null)
    return worst(causes) ?? 'a'
  })
  return { loss: worst(classes), lost, ...judgement }
}
