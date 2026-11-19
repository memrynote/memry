/**
 * Zero-loss oracle (#5225): does a device hold exactly the vault?
 *
 * Pure checks over plain JSON-serializable state, so the sync harness and the
 * staging scripts feed it the same shapes. `fetchServerTruth` builds the server
 * side over HTTP. Each shell dumps its own local side from its own tables.
 */

export type VectorClock = Record<string, number>

/** One live record on the server: its type and the clock of its stored row. */
export interface ServerRecord {
  type: string
  clock: VectorClock
}

/**
 * One CRDT document (note or journal body) on the server. `updateSequences`
 * lists every update row the server still holds; rows at or below the snapshot's
 * `sequenceNum` may already be pruned (protocol 07 §7.5).
 */
export interface ServerBody {
  snapshot: { sequenceNum: number; revision: string } | null
  updateSequences: number[]
}

export interface ServerVaultTruth {
  /** Every live record of `GET /sync/manifest`. */
  records: Record<string, ServerRecord>
  /** Ids whose latest server row is a tombstone. */
  deleted: string[]
  /** Bodies of every live record of a CRDT type, keyed by record id. */
  bodies: Record<string, ServerBody>
}

export interface LocalRecord {
  type: string
  clock: VectorClock
  deleted: boolean
}

/**
 * What a device applied to one CRDT document: the snapshot revision it holds as
 * baseline (null for none) and every update sequence it applied on top, in
 * apply order, one entry per application.
 */
export interface LocalBody {
  snapshotRevision: string | null
  appliedSequences: number[]
}

export interface LocalVaultState {
  records: Record<string, LocalRecord>
  bodies: Record<string, LocalBody>
}

export type FindingKind =
  | 'missing_record'
  | 'deleted_locally'
  | 'type_mismatch'
  | 'stale_record'
  | 'clock_diverged'
  | 'resurrected'
  | 'unexpected_record'
  | 'body_missing'
  | 'body_stale_snapshot'
  | 'body_short'
  | 'body_applied_twice'
  | 'body_unknown_sequence'
  | 'digest_missing'
  | 'digest_mismatch'

export interface Finding {
  kind: FindingKind
  itemId: string
  detail: string
}

const dominates = (a: VectorClock, b: VectorClock): boolean =>
  Object.entries(b).every(([device, tick]) => (a[device] ?? 0) >= tick)

const formatClock = (clock: VectorClock): string => JSON.stringify(clock)

const checkRecords = (truth: ServerVaultTruth, local: LocalVaultState): Finding[] => {
  const findings: Finding[] = []
  const deleted = new Set(truth.deleted)

  for (const [id, server] of Object.entries(truth.records)) {
    const mine = local.records[id]
    if (!mine) {
      findings.push({ kind: 'missing_record', itemId: id, detail: `${server.type} absent locally` })
    } else if (mine.deleted) {
      findings.push({
        kind: 'deleted_locally',
        itemId: id,
        detail: `${server.type} live on server, deleted locally`
      })
    } else if (mine.type !== server.type) {
      findings.push({
        kind: 'type_mismatch',
        itemId: id,
        detail: `server ${server.type}, local ${mine.type}`
      })
    } else if (!dominates(mine.clock, server.clock) || !dominates(server.clock, mine.clock)) {
      const behind = dominates(server.clock, mine.clock)
      findings.push({
        kind: behind ? 'stale_record' : 'clock_diverged',
        itemId: id,
        detail: `${server.type} server clock ${formatClock(server.clock)}, local ${formatClock(mine.clock)}`
      })
    }
  }

  for (const [id, mine] of Object.entries(local.records)) {
    if (mine.deleted || truth.records[id]) continue
    findings.push(
      deleted.has(id)
        ? {
            kind: 'resurrected',
            itemId: id,
            detail: `${mine.type} live locally, deleted on server`
          }
        : {
            kind: 'unexpected_record',
            itemId: id,
            detail: `${mine.type} live locally, unknown to server`
          }
    )
  }

  return findings
}

const duplicatesOf = (values: number[]): number[] => {
  const seen = new Set<number>()
  const repeated = new Set<number>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

const checkBody = (id: string, server: ServerBody, mine: LocalBody | undefined): Finding[] => {
  const applied = mine?.appliedSequences ?? []
  const localRevision = mine?.snapshotRevision ?? null
  const serverHasBody = server.snapshot !== null || server.updateSequences.length > 0
  if (serverHasBody && localRevision === null && applied.length === 0) {
    return [{ kind: 'body_missing', itemId: id, detail: 'server holds a body, device none' }]
  }

  const findings: Finding[] = []
  const serverRevision = server.snapshot?.revision ?? null
  if (serverRevision !== localRevision) {
    findings.push({
      kind: 'body_stale_snapshot',
      itemId: id,
      detail: `server snapshot ${serverRevision ?? 'none'}, local ${localRevision ?? 'none'}`
    })
  }

  const watermark = server.snapshot?.sequenceNum ?? 0
  const appliedSet = new Set(applied)
  const short = server.updateSequences.filter((seq) => seq > watermark && !appliedSet.has(seq))
  if (short.length > 0) {
    findings.push({
      kind: 'body_short',
      itemId: id,
      detail: `missing update sequences ${short.join(',')} (snapshot through ${watermark})`
    })
  }

  const twice = duplicatesOf(applied)
  if (twice.length > 0) {
    findings.push({
      kind: 'body_applied_twice',
      itemId: id,
      detail: `update sequences applied more than once: ${twice.join(',')}`
    })
  }

  const known = new Set(server.updateSequences)
  const unknown = [...appliedSet].filter((seq) => seq > watermark && !known.has(seq))
  if (unknown.length > 0) {
    findings.push({
      kind: 'body_unknown_sequence',
      itemId: id,
      detail: `applied sequences the server does not hold: ${unknown.join(',')}`
    })
  }
  return findings
}

/** Structural check: the device against the server's manifest and body sequences. */
export const checkStructural = (truth: ServerVaultTruth, local: LocalVaultState): Finding[] => [
  ...checkRecords(truth, local),
  ...Object.entries(truth.bodies).flatMap(([id, server]) => checkBody(id, server, local.bodies[id]))
]

export interface DeviceDigests {
  label: string
  /** Item id to its chapter 12 §12.11 digest, for every live item. */
  digests: Record<string, string>
}

/** Semantic check: two independently bootstrapped devices agree on every item's digest. */
export const checkSemantic = (a: DeviceDigests, b: DeviceDigests): Finding[] => {
  const findings: Finding[] = []
  const ids = new Set([...Object.keys(a.digests), ...Object.keys(b.digests)])
  for (const id of ids) {
    const left = a.digests[id]
    const right = b.digests[id]
    if (left === undefined || right === undefined) {
      const [has, lacks] = left === undefined ? [b, a] : [a, b]
      findings.push({
        kind: 'digest_missing',
        itemId: id,
        detail: `present on ${has.label}, absent on ${lacks.label}`
      })
    } else if (left !== right) {
      findings.push({
        kind: 'digest_mismatch',
        itemId: id,
        detail: `${a.label} ${left}, ${b.label} ${right}`
      })
    }
  }
  return findings
}

export const formatFindings = (findings: Finding[]): string =>
  findings.length === 0
    ? 'zero-loss oracle GREEN: 0 findings'
    : [
        `zero-loss oracle RED: ${findings.length} finding(s)`,
        ...findings.map((f) => `  ${f.kind} ${f.itemId}: ${f.detail}`)
      ].join('\n')

/** Throws with every finding named when the oracle is red. */
export const assertZeroLoss = (findings: Finding[]): void => {
  if (findings.length > 0) throw new Error(formatFindings(findings))
}
