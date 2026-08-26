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
  stateB64: z.string()
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
  status: z.enum(['ready', 'pending', 'missing']).default('ready'),
  /** Bumped when the bytes land, so a late attachment invalidates the cache. */
  revision: z.number().int().optional()
})

/**
 * Insert an image at the cursor. Additive within v1, and safe to add without a
 * version bump because the guest is a PREBUILT asset that ships with the app
 * that speaks to it — there is no older peer on this boundary, only a stale
 * asset, which the freshness hash already catches.
 *
 * The payload is a vault-relative REFERENCE, not bytes: the reference is what
 * the note stores and what desktop resolves, and the guest fetches the bytes
 * back through the ordinary `asset-req` path so there is exactly one
 * resolution route.
 */
export const HostInsertImageSchema = z.object({
  type: z.literal('insert-image'),
  ref: z.string().min(1),
  alt: z.string().default(''),
  /** 0 means "natural size"; matches the inline-image prop's own convention. */
  width: z.number().int().min(0).default(0)
})

export const BRIDGE_EXEC_COMMANDS = ['undo', 'redo', 'focus', 'blur', 'flush'] as const
export type BridgeExecCommand = (typeof BRIDGE_EXEC_COMMANDS)[number]

export const HostExecSchema = z.object({
  type: z.literal('exec'),
  cmd: z.enum(BRIDGE_EXEC_COMMANDS)
})

export const HostMsgSchema = z.discriminatedUnion('type', [
  HostDocLoadSchema,
  HostYUpdateSchema,
  HostCfgSchema,
  HostWikiCandidatesSchema,
  HostAssetSchema,
  HostExecSchema,
  HostInsertImageSchema
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
  /** Bucketed msgs-per-envelope: index 0 = 1 msg, 1 = 2, 2 = 3–4, 3 = 5–8, 4 = 9+. */
  msgsPerEnvelope: number[]
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
    seqGaps: 0,
    resyncs: 0
  }
}
