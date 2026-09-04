import { z } from 'zod'

/**
 * RN↔WebView editor bridge, protocol v1
 * (specs/001-mobile-app/contracts/webview-bridge.md).
 *
 * The note body is the only WebView surface on mobile: it hosts BlockNote so
 * `@memry/editor-schema` stays the single source of truth. The Y.Doc lives on
 * the React Native side — mirroring Electron main-process ownership — and the
 * WebView gets a bridge provider analogous to desktop's IPC provider.
 *
 * This module is the ONE definition both sides compile against: the RN host
 * (`apps/mobile/src/editor/*`) and the WebView guest
 * (`apps/mobile/editor-web/src/*`). Hand-written `any` at this boundary is a
 * defect (Constitution II), and the drift risk is not the types — both halves
 * import this file — but the PREBUILT WebView asset going stale against it.
 * `pnpm --filter @memry/mobile editor:check` is the gate for that; the `ready`
 * handshake carries the same hash so a stale asset also fails at runtime.
 */

/** Bump = both sides regenerate, and `ready` handshakes across versions fail. */
export const BRIDGE_PROTOCOL_VERSION = 1

/**
 * Flush cadence, adopted from the G0-d device run (R4): delivery p95 2.0 ms,
 * apply p95 0.08 ms, zero seq gaps. Per-keystroke crossings are a defect
 * regardless of measured comfort (Constitution V), so both ends accumulate.
 */
export const BRIDGE_T_FLUSH_MS = 24

/** Byte ceiling per envelope, pre-base64. */
export const BRIDGE_B_MAX_BYTES = 256 * 1024

/** Yjs fragment BlockNote binds to; must match desktop's collaboration setup. */
export const BRIDGE_FRAGMENT_NAME = 'prosemirror'

// ---------------------------------------------------------------------------
// RN (host) → WebView (guest)
// ---------------------------------------------------------------------------

export const HostDocLoadSchema = z.object({
  type: z.literal('doc-load'),
  docId: z.string().min(1),
  /** Full Yjs state as an encoded update, base64. */
  stateB64: z.string(),
  /**
   * Markdown to seed an EMPTY doc with, parsed by the guest.
   *
   * A note's body can exist as markdown without any CRDT state yet: a note
   * created on this device, or one pulled from a desktop whose create-time
   * `content` never got a CRDT update. Without a seed those open blank, and
   * the first keystroke replaces the real body for every device.
   *
   * The guest parses it, because turning markdown into blocks is the schema's
   * business — building the nodes on the host is how a surface writes
   * structures the other shells cannot read. Applied ONLY when the doc is
   * genuinely empty, so it can never overwrite real content.
   */
  seedMarkdown: z.string().optional()
})

export const HostYUpdateSchema = z.object({
  type: z.literal('y-update'),
  docId: z.string().min(1),
  updatesB64: z.array(z.string())
})

export const BridgeCfgSchema = z.object({
  theme: z.enum(['light', 'dark']),
  locale: z.string().min(1),
  rtl: z.boolean(),
  reducedMotion: z.boolean(),
  /** Also driven by kill-switch / entitlement state, not just UI intent. */
  readOnly: z.boolean()
})

export const HostCfgSchema = BridgeCfgSchema.extend({
  type: z.literal('cfg')
})

export const WikiCandidateSchema = z.object({
  /** Note id to navigate to on accept. */
  id: z.string().min(1),
  /** Display name — the alias the editor writes, not the file path. */
  title: z.string(),
  folderPath: z.string().optional()
})

export const HostWikiCandidatesSchema = z.object({
  type: z.literal('wiki-candidates'),
  reqId: z.string().min(1),
  items: z.array(WikiCandidateSchema)
})

export const HostAssetSchema = z.object({
  type: z.literal('asset'),
  reqId: z.string().min(1),
  /** Exactly one of `url` / `b64` is present when `status` is 'ready'. */
  url: z.string().optional(),
  b64: z.string().optional(),
  mime: z.string().optional(),
  /**
   * Lazy download honours the Wi-Fi-only default, so "not here yet" is a
   * first-class answer: the guest renders a placeholder with a fetch action
   * instead of a broken image (FR / T072).
   */
  status: z.enum(['ready', 'pending', 'missing']).default('ready')
})

/**
 * Insert an attachment at the cursor. Additive within v1, and safe to add
 * without a version bump because the guest is a PREBUILT asset that ships with
 * the app that speaks to it — there is no older peer on this boundary, only a
 * stale asset, which the freshness hash already catches.
 *
 * The payload is a vault-relative REFERENCE, not bytes: the reference is what
 * the note stores and what desktop resolves, and the guest fetches the bytes
 * back through the ordinary `asset-req` path so there is exactly one
 * resolution route.
 */
export const HostInsertAttachmentSchema = z.object({
  type: z.literal('insert-attachment'),
  ref: z.string().min(1),
  name: z.string().default(''),
  /**
   * Drives which block the guest inserts: an image block for `image/*`, a file
   * block for everything else. Routing a PDF through the image path is how a
   * document ends up as a permanently broken picture.
   */
  mime: z.string().default('application/octet-stream'),
  /** 0 means "natural size"; matches the inline-image prop's own convention. */
  width: z.number().int().min(0).default(0)
})

export const BRIDGE_EXEC_COMMANDS = ['undo', 'redo', 'focus', 'blur', 'flush'] as const
export type BridgeExecCommand = (typeof BRIDGE_EXEC_COMMANDS)[number]

export const HostExecSchema = z.object({
  type: z.literal('exec'),
  cmd: z.enum(BRIDGE_EXEC_COMMANDS)
})

/**
 * A fixed, tiny envelope the host sends around `doc-load` to time the crossing
 * itself (#2044).
 *
 * `doc-load` takes 3.26 s to reach the guest and the interval is FLAT across a
 * 6-60x content range, which the payload cannot explain on its own. The probe
 * separates the two candidates: sent immediately before `doc-load` it carries a
 * few dozen bytes down the same channel, so a probe that is also slow indicts
 * the channel and a probe that is fast indicts the payload.
 *
 * The guest does nothing with it but take a mark, so it can never change what
 * the editor shows.
 */
export const HostProbeSchema = z.object({
  type: z.literal('probe'),
  /** Whether it was queued ahead of `doc-load` or behind it. */
  slot: z.enum(['early', 'late'])
})

export const HostMsgSchema = z.discriminatedUnion('type', [
  HostDocLoadSchema,
  HostYUpdateSchema,
  HostCfgSchema,
  HostWikiCandidatesSchema,
  HostAssetSchema,
  HostExecSchema,
  HostInsertAttachmentSchema,
  HostProbeSchema
])

// ---------------------------------------------------------------------------
// WebView (guest) → RN (host)
// ---------------------------------------------------------------------------

export const GuestReadySchema = z.object({
  type: z.literal('ready'),
  protocolV: z.number().int(),
  /** `@memry/editor-schema` spec-key fingerprint the bundle was built with. */
  schemaV: z.string(),
  /** Freshness stamp of the prebuilt asset; see `editor:check`. */
  contractHash: z.string().optional()
})

export const GuestYUpdateSchema = z.object({
  type: z.literal('y-update'),
  docId: z.string().min(1),
  updatesB64: z.array(z.string())
})

export const GuestWikiQuerySchema = z.object({
  type: z.literal('wiki-query'),
  reqId: z.string().min(1),
  query: z.string()
})

export const GuestAssetReqSchema = z.object({
  type: z.literal('asset-req'),
  reqId: z.string().min(1),
  /** Vault-relative reference exactly as written in the doc. */
  ref: z.string()
})

export const GuestNavSchema = z.object({
  type: z.literal('nav'),
  /** Wiki-link target: `Note title` or `Note title#Heading`. */
  target: z.string()
})

export const GuestMetricsSchema = z.object({
  type: z.literal('metrics'),
  /** Content height in CSS px, for native chrome sizing. */
  h: z.number(),
  /** Selection anchor offset from the top of the doc, in CSS px. */
  selAnchor: z.number()
})

/**
 * The mounted document is on screen. Sent once per `doc-load`, from a frame
 * callback, and it is the end of the note-open latency trace
 * (`apps/mobile/src/editor/__rig__/open-trace.ts`).
 *
 * Its own message rather than a reuse of `metrics`, because `metrics` is a
 * 200 ms TRAILING-edge throttle reporting the SETTLED height: reading a paint
 * time off it would overstate note-open latency by up to 200 ms.
 *
 * Additive within v1, and deliberately NOT a version bump — the same argument
 * `insert-attachment` makes for the other direction. The guest is a PREBUILT
 * asset that ships inside the app that speaks to it, so there is no older peer
 * on this boundary, only a stale asset, which `editor:check` and the
 * `contractHash` in the `ready` handshake already catch. The point that
 * argument does not make: a stale asset simply never sends `painted`, which
 * costs one missing mark in a trace, whereas a bump would make the host reject
 * the `ready` handshake outright (the `protocolV` mismatch branch in
 * `editor-view.tsx`) and turn a measurement gap into a dead editor.
 */
/**
 * Guest-side sub-marks across the `doc-load` path, as absolute epoch
 * milliseconds (#2043).
 *
 * Epoch, not offsets: the host's trace is already keyed on `Date.now()`
 * (`apps/mobile/src/editor/__rig__/open-trace.ts`), so absolute stamps drop
 * straight into the SAME phase table instead of forming a second timeline the
 * reviewer has to align by hand. Both ends read the device wall clock, which
 * is also what the envelope's `sentAt` already assumes.
 *
 * The order is the order the guest reaches them:
 *   * `docStart` — the WebView document's navigation start, derived as
 *     `Date.now() - performance.now()`. The zero the guest's own clock counts
 *     from, and the only mark that is computed rather than taken.
 *   * `importsStart` — the first guest module to evaluate. Everything between
 *     here and `scriptEval` is the bundle's dependency graph evaluating,
 *     shiki's included.
 *   * `scriptEval` — the entry module's body, so every import has evaluated.
 *   * `schemaBuilt` — `createMemrySchema` returned, which is where
 *     `createCodeBlockSpec(codeBlockOptions)` is paid.
 *   * `readySent` — the handshake is on the wire.
 *   * `idleTickFirst` / `idleTickLast` — a 100 ms timer the guest runs from
 *     `ready` until `doc-load` lands, and then stops. It answers whether the
 *     guest's own JS thread is alive during the wait, which is the fork between
 *     a suspended web content process and a delivery that never arrives.
 *   * `probeEarlyRecv` / `probeLateRecv` — the tiny probe envelopes queued
 *     immediately before and immediately after `doc-load`. Absent unless the
 *     rig asked for them; see `HostProbeSchema`.
 *   * `docLoadRecv` — `doc-load` reached the guest's handler.
 *   * `yApplied` — the Y state is in the replica and the fragment is bound.
 *   * `createStart` / `createEnd` — `BlockNoteEditor.create`.
 *   * `mountEnd` — `editor.mount` returned; the DOM exists, unlaid-out.
 *   * `shikiStart` / `shikiSync` / `shikiEnd` — the highlighter factory
 *     entered, returned (its SYNCHRONOUS cost), and its promise settled. The
 *     last one is absent whenever the highlighter outlives the paint, which is
 *     itself the answer to "is the highlighter on the paint path".
 *   * `seedEnd` — the markdown seed branch is done, taken whether or not a
 *     seed was applied.
 *   * `guestPainted` — inside the frame callback, before the send. The host's
 *     own `painted` mark is this plus bridge delivery.
 */
export const GUEST_PAINT_MARKS = [
  'docStart',
  'importsStart',
  'scriptEval',
  'schemaBuilt',
  'readySent',
  'idleTickFirst',
  'idleTickLast',
  'probeEarlyRecv',
  'docLoadRecv',
  'probeLateRecv',
  'yApplied',
  'createStart',
  'createEnd',
  'mountEnd',
  'shikiStart',
  'shikiSync',
  'shikiEnd',
  'seedEnd',
  'guestPainted'
] as const

export type GuestPaintMark = (typeof GUEST_PAINT_MARKS)[number]

export const GuestPaintedSchema = z.object({
  type: z.literal('painted'),
  docId: z.string().min(1),
  /**
   * Partial by construction: a mark the guest never reached is absent, and an
   * absent mark is a finding rather than a gap to paper over with a zero.
   *
   * Optional as a whole so a STALE prebuilt asset — the only peer that can
   * disagree here — still delivers a legal `painted` and keeps the end-to-end
   * number, losing only the breakdown.
   */
  marks: z.partialRecord(z.enum(GUEST_PAINT_MARKS), z.number()).optional()
})

export const GuestErrSchema = z.object({
  type: z.literal('err'),
  code: z.string(),
  detail: z.string()
})

export const GuestMsgSchema = z.discriminatedUnion('type', [
  GuestReadySchema,
  GuestYUpdateSchema,
  GuestWikiQuerySchema,
  GuestAssetReqSchema,
  GuestNavSchema,
  GuestMetricsSchema,
  GuestPaintedSchema,
  GuestErrSchema
])

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const EnvelopeBase = {
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  /** Bridge session id; origin tag that keeps updates from echoing back. */
  sid: z.string().min(1),
  /** Per-sender monotonic. A gap means the receiver asks for a full resync. */
  seq: z.number().int().min(1),
  /**
   * Sender clock at flush. Not in the original contract sketch — added for the
   * G3 keystroke-latency instrumentation (T074), which needs a send stamp it
   * did not fabricate. Optional so a peer that omits it stays legal.
   */
  sentAt: z.number().int().optional()
}

export const HostEnvelopeSchema = z.object({ ...EnvelopeBase, msgs: z.array(HostMsgSchema) })
export const GuestEnvelopeSchema = z.object({ ...EnvelopeBase, msgs: z.array(GuestMsgSchema) })

export type HostMsg = z.infer<typeof HostMsgSchema>
export type GuestMsg = z.infer<typeof GuestMsgSchema>
export type HostEnvelope = z.infer<typeof HostEnvelopeSchema>
export type GuestEnvelope = z.infer<typeof GuestEnvelopeSchema>
export type BridgeCfg = z.infer<typeof BridgeCfgSchema>
export type WikiCandidate = z.infer<typeof WikiCandidateSchema>

/** Either direction, for code that only cares about the framing. */
export interface BridgeEnvelope<T> {
  v: typeof BRIDGE_PROTOCOL_VERSION
  sid: string
  seq: number
  sentAt?: number
  msgs: T[]
}

/** Counters both ends expose in dev builds — the G3 batching proof (T075). */
export interface BridgeCounters {
  envelopesSent: number
  msgsSent: number
  envelopesReceived: number
  msgsReceived: number
  /**
   * Bucketed msgs-per-envelope for what this end SENT.
   * Index 0 = 1 msg, 1 = 2, 2 = 3–4, 3 = 5–8, 4 = 9+.
   */
  msgsPerEnvelope: number[]
  /**
   * The same buckets for what this end RECEIVED.
   *
   * On the RN host this is the keystroke-coalescing measurement, and it is the
   * one G3 asks for: the batching that matters is the WebView's, since that is
   * where typing happens. Reading the sent histogram instead describes
   * RN→WebView traffic and reports ~1.00 forever.
   */
  msgsPerEnvelopeReceived: number[]
  /**
   * `y-update` messages received, and the envelopes that carried at least one.
   *
   * The G3 batching proof is about KEYSTROKE coalescing, so it divides these
   * two rather than the all-message counters: `metrics` and `err` traffic
   * would otherwise inflate the ratio and let the proof pass on noise.
   */
  yUpdatesReceived: number
  yUpdateEnvelopesReceived: number
  seqGaps: number
  resyncs: number
}

export const MSGS_PER_ENVELOPE_BUCKETS = [1, 2, 4, 8, Infinity] as const

export function bucketForMsgCount(count: number): number {
  for (let i = 0; i < MSGS_PER_ENVELOPE_BUCKETS.length; i++) {
    if (count <= MSGS_PER_ENVELOPE_BUCKETS[i]) return i
  }
  return MSGS_PER_ENVELOPE_BUCKETS.length - 1
}

export function emptyBridgeCounters(): BridgeCounters {
  return {
    envelopesSent: 0,
    msgsSent: 0,
    envelopesReceived: 0,
    msgsReceived: 0,
    msgsPerEnvelope: new Array(MSGS_PER_ENVELOPE_BUCKETS.length).fill(0),
    msgsPerEnvelopeReceived: new Array(MSGS_PER_ENVELOPE_BUCKETS.length).fill(0),
    yUpdatesReceived: 0,
    yUpdateEnvelopesReceived: 0,
    seqGaps: 0,
    resyncs: 0
  }
}
