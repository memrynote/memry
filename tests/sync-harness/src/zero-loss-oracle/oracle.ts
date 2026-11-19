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
 * What a device persists for one CRDT document: the snapshot revision it holds
 * as baseline (null for none), the highest update sequence it applied (0 for
 * none), and whether the document's content is empty. Clients keep a watermark,
 * not an apply log, so a gap below it or an update applied twice is invisible
 * here: the semantic body digest (§12.11) catches those.
 */
export interface LocalBody {
  snapshotRevision: string | null
  appliedThrough: number
  empty: boolean
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
  | 'body_unknown_sequence'
  | 'body_unexpected_content'
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

const checkBody = (id: string, server: ServerBody, mine: LocalBody | undefined): Finding[] => {
  const localRevision = mine?.snapshotRevision ?? null
  const appliedThrough = mine?.appliedThrough ?? 0
  if (server.snapshot === null && server.updateSequences.length === 0) {
    // Expected-empty (RCA-5225 rule 1): the server holds no body for this note.
    return mine && !mine.empty
      ? [
          {
            kind: 'body_unexpected_content',
            itemId: id,
            detail: 'server holds no body, device has content'
          }
        ]
      : []
  }
  if (localRevision === null && appliedThrough === 0) {
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

  const serverThrough = Math.max(server.snapshot?.sequenceNum ?? 0, ...server.updateSequences)
  if (appliedThrough < serverThrough) {
    findings.push({
      kind: 'body_short',
      itemId: id,
      detail: `applied through ${appliedThrough}, server through ${serverThrough}`
    })
  } else if (appliedThrough > serverThrough) {
    findings.push({
      kind: 'body_unknown_sequence',
      itemId: id,
      detail: `applied through ${appliedThrough}, beyond server ${serverThrough}`
    })
  }
  return findings
}

export interface StructuralReport {
  findings: Finding[]
  counts: {
    /** Manifest notes with no body row on the server; a rise is the loss signal. */
    expected_empty: number
    /** Local bodies whose id is not in the manifest (RCA-5225 rule 2); never required. */
    body_without_record: number
  }
}

/** Structural check: the device against the server's manifest and body sequences. */
export const checkStructural = (
  truth: ServerVaultTruth,
  local: LocalVaultState
): StructuralReport => ({
  findings: [
    ...checkRecords(truth, local),
    ...Object.entries(truth.bodies).flatMap(([id, server]) =>
      checkBody(id, server, local.bodies[id])
    )
  ],
  counts: {
    expected_empty: Object.values(truth.bodies).filter(
      (body) => body.snapshot === null && body.updateSequences.length === 0
    ).length,
    body_without_record: Object.keys(local.bodies).filter((id) => !truth.records[id]).length
  }
})

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

export const formatFindings = (
  findings: Finding[],
  counts: Partial<StructuralReport['counts']> = {}
): string => {
  const tally = Object.entries(counts).map(([name, n]) => `${name}=${n}`)
  return [
    findings.length === 0
      ? 'zero-loss oracle GREEN: 0 findings'
      : `zero-loss oracle RED: ${findings.length} finding(s)`,
    ...(tally.length > 0 ? [`  counts: ${tally.join(' ')}`] : []),
    ...findings.map((f) => `  ${f.kind} ${f.itemId}: ${f.detail}`)
  ].join('\n')
}

/** Throws with every finding named when the oracle is red. */
export const assertZeroLoss = (
  findings: Finding[],
  counts?: Partial<StructuralReport['counts']>
): void => {
  if (findings.length > 0) throw new Error(formatFindings(findings, counts))
}
