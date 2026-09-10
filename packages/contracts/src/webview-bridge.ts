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
  readOnly: z.boolean(),
  /**
   * Space to reserve at the top of the document for native chrome drawn OVER
   * it, in CSS px.
   *
   * The note title and its metadata are RN views floating above the WebView, so
   * the document has to start below them without the host resizing the guest's
   * frame — resizing it would make the reader's scroll and the header's travel
   * two different distances. Absent means reserve nothing, which is what every
   * caller that draws no chrome already means.
   */
  headerHeight: z.number().min(0).optional(),
  /**
   * Height of the software keyboard, in CSS px, as the HOST measures it.
   *
   * The block picker replaces the keyboard, so it has to be exactly as tall as
   * the keyboard was. The guest cannot measure that for itself: its frame is
   * shrunk by a KeyboardAvoidingView, so `visualViewport` only ever reports the
   * part of the keyboard that overlapped the WebView -- which is why the picker
   * used to open as a sliver. Last known height, kept across a dismissal,
   * because the picker opens after the keyboard has already gone.
   */
  keyboardHeight: z.number().min(0).optional(),
  /**
   * First day of the week, for the date pill's `This / Next / Last <Weekday>`
   * label tier.
   *
   * Desktop reads it from the synced `calendar.weekStartDay` setting and the
   * pill's label depends on it -- 5 September is "Next Saturday" from a Monday
   * week and "This Saturday" from a Sunday one. The guest cannot pick for
   * itself: guessing from the device locale would print a different day name on
   * the phone than on the desktop for the same date, which is why the tier was
   * left out of `dateMentionLabel` until this field existed. Absent means
   * Monday, the same default `settings-schemas.ts` ships.
   */
  weekStart: z.enum(['sunday', 'monday']).optional()
})

export const HostCfgSchema = BridgeCfgSchema.extend({
  type: z.literal('cfg')
})

/**
 * One row of the `[[` autocomplete menu.
 *
 * The WebView has no vault access, so the whole `[[target#heading|alias]]`
 * grammar is parsed HOST-side and arrives here already resolved into rows. The
 * guest only renders `title`/`subtitle` and inserts `target`/`alias`; it never
 * re-reads the query to decide what a row means. That keeps one parser instead
 * of two that can disagree about, say, a note actually titled `Sprint #4`.
 */
export const WikiCandidateSchema = z.object({
  /**
   * `note` and `heading` link to something that exists. `create` links to a
   * note that does not exist yet — desktop offers creation at CLICK time, not
   * here. `alias` commits the label typed after `|`. `empty` is a message row
   * that keeps the menu open while the user backspaces; it is not selectable.
   */
  kind: z.enum(['note', 'heading', 'alias', 'create', 'empty', 'tag']).default('note'),
  /** Sync item id of the note the row points at. Empty when there is none. */
  id: z.string().default(''),
  /** Primary label. */
  title: z.string(),
  /** Secondary label — the folder path, the target an alias renames, a hint. */
  subtitle: z.string().default(''),
  /** The note's own emoji, when it has one. Named and custom icons resolve to
   * nothing here: the WebView has no glyph set and no icon bytes. */
  icon: z.string().default(''),
  /** What `[[…]]` will carry. Empty means the row cannot be accepted. */
  target: z.string().default(''),
  /** Chip display text. Empty means "show the target". */
  alias: z.string().default(''),
  /**
   * Tag colour for a `tag` row — a palette name or a `#rrggbb`, exactly as the
   * `tag_definition` row stores it, so the chip the guest writes carries the
   * colour every other surface already paints that tag with. Empty means
   * nobody picked one and the shared hash decides. Kind-specific, like
   * `headingLevel`, so every existing row shape stays legal untouched.
   */
  color: z.string().optional(),
  /** Indent depth for `heading` rows. */
  headingLevel: z.number().int().min(1).max(6).optional()
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
/**
 * Which document a host command is meant for.
 *
 * Optional and additive, for the same reason `insert-attachment` itself is:
 * the guest ships inside the app that speaks to it, so an older asset that
 * does not know the field ignores it and behaves exactly as it does today.
 *
 * It exists because the guest is now a LONG-LIVED WebView shared by every note
 * (#2030). `y-update` has carried a `docId` since v1 and these two never did,
 * so a command queued by a note that has left the screen would land on
 * whichever note is on it. Absent still means "whatever is mounted", which is
 * what an unaddressed command has always meant.
 */
const AddressedDocId = z.string().min(1).optional()

export const EDITOR_ATTACHMENT_BLOCK_TYPES = ['image', 'file'] as const
export type EditorAttachmentBlockType = (typeof EDITOR_ATTACHMENT_BLOCK_TYPES)[number]

export const HostInsertAttachmentSchema = z.object({
  type: z.literal('insert-attachment'),
  docId: AddressedDocId,
  /**
   * The block the toolbar asked to create. Optional for v1 compatibility;
   * older callers still get the historical image-by-MIME/file fallback.
   */
  blockType: z.enum(EDITOR_ATTACHMENT_BLOCK_TYPES).optional(),
  /**
   * Cursor block captured before the native picker covered the editor. The
   * selection can blur while Photos/Documents is open, so insertion must not
   * depend on whichever cursor WebKit reports after the picker returns.
   */
  referenceBlockId: z.string().min(1).optional(),
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

/** Request a snapshot of the mounted document through its schema serializer. */
export const HostExportMarkdownSchema = z.object({
  type: z.literal('export-markdown'),
  reqId: z.string().min(1),
  docId: z.string().min(1)
})

/**
 * Request the mounted document as a standalone HTML page, for export. Additive
 * within v1 for the reason `insert-attachment` sets out above.
 *
 * Separate from `export-markdown` rather than a format flag on it, because the
 * two answer different questions. Markdown is the document re-serialized
 * through the schema, which is what a copy or a duplicate wants. This is the
 * guest's own RENDERED DOM plus the stylesheet it is already rendering under,
 * which is what a PDF wants: nothing on the host re-derives BlockNote's layout,
 * so the export cannot drift from what the reader is looking at.
 */
export const HostExportHtmlSchema = z.object({
  type: z.literal('export-html'),
  reqId: z.string().min(1),
  docId: z.string().min(1)
})

export const BRIDGE_EXEC_COMMANDS = ['undo', 'redo', 'focus', 'blur', 'flush', 'open-find'] as const
export type BridgeExecCommand = (typeof BRIDGE_EXEC_COMMANDS)[number]

export const HostExecSchema = z.object({
  type: z.literal('exec'),
  cmd: z.enum(BRIDGE_EXEC_COMMANDS),
  /**
   * Left unset for `flush` and `blur`, which are transport-level and belong to
   * no document: addressing them would make a background flush from a note
   * that is still mounted but off screen silently do nothing.
   */
  docId: AddressedDocId
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
  HostExportMarkdownSchema,
  HostExportHtmlSchema,
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

/**
 * Which inline trigger opened the menu, and therefore what the rows mean.
 *
 * `wiki` is the original `[[` autocomplete. `tag` is `#` over the vault's tags
 * and `mention` is `@` over its notes; both ride the same request because the
 * round trip, the debounce and the abandoned-query heuristic are identical and
 * only the row source differs.
 */
export const INLINE_MENU_TRIGGERS = ['wiki', 'tag', 'mention'] as const
export type InlineMenuTrigger = (typeof INLINE_MENU_TRIGGERS)[number]

export const GuestWikiQuerySchema = z.object({
  type: z.literal('wiki-query'),
  reqId: z.string().min(1),
  query: z.string(),
  /**
   * Defaulted rather than required: a STALE prebuilt guest asset still sends
   * the v1 shape, and `wiki` is exactly what it meant by it.
   */
  trigger: z.enum(INLINE_MENU_TRIGGERS).default('wiki')
})

export const GuestAssetReqSchema = z.object({
  type: z.literal('asset-req'),
  reqId: z.string().min(1),
  /** Vault-relative reference exactly as written in the doc. */
  ref: z.string()
})

export const GuestInsertRequestSchema = z.object({
  type: z.literal('insert-request'),
  docId: z.string().min(1),
  blockType: z.enum(EDITOR_ATTACHMENT_BLOCK_TYPES),
  referenceBlockId: z.string().min(1)
})

/**
 * Whether the software keyboard is covering the mounted document.
 *
 * The guest is authoritative because WKWebView's `visualViewport` is the only
 * layer that sees the same viewport the fixed editor toolbar is positioned
 * against. Addressing the state prevents a late resize from a departing note
 * hiding or showing the native footer for the note that replaced it.
 */
export const GuestKeyboardVisibilitySchema = z.object({
  type: z.literal('keyboard-visibility'),
  docId: z.string().min(1),
  visible: z.boolean()
})

export const GuestEditorPanelVisibilitySchema = z.object({
  type: z.literal('editor-panel-visibility'),
  docId: z.string().min(1),
  open: z.boolean()
})

export const GuestMarkdownExportSchema = z.object({
  type: z.literal('markdown-export'),
  reqId: z.string().min(1),
  docId: z.string().min(1),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), markdown: z.string() }),
    z.object({ status: z.literal('error'), detail: z.string() })
  ])
})

/**
 * The mounted document as a standalone HTML page. Answer to `export-html`.
 *
 * `html` is a whole document, not a fragment: the guest wraps its rendered
 * `#root` subtree together with every `<style>` the page is running under, so
 * the string the host receives renders identically with no stylesheet the host
 * would have to keep in step.
 */
export const GuestHtmlExportSchema = z.object({
  type: z.literal('html-export'),
  reqId: z.string().min(1),
  docId: z.string().min(1),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), html: z.string() }),
    z.object({ status: z.literal('error'), detail: z.string() })
  ])
})

export const GuestNavSchema = z.object({
  type: z.literal('nav'),
  /** Wiki-link target: `Note title` or `Note title#Heading`. */
  target: z.string()
})

/**
 * A tapped external link, handed to the OS by the host.
 *
 * The guest cannot open one itself. Its document is `about:blank` with a CSP
 * that forbids every remote fetch, so a navigation inside the WebView is
 * either blocked or leaves the editor with no way back — which is why every
 * renderer here draws its links as inert elements and routes the tap instead.
 *
 * The URL is UNTRUSTED at this boundary: it comes from note content, which is
 * whatever any device ever wrote. The host validates the scheme against the
 * same allowlist desktop applies before `shell.openExternal`
 * (`apps/mobile/src/editor/external-url.ts`); `javascript:` and custom app
 * schemes are dropped there, not here.
 *
 * Additive within v1 for the reason `painted` states: the guest is a prebuilt
 * asset shipped inside the app that speaks to it, so a bump would only turn a
 * stale asset into a dead editor. A stale asset simply never sends this.
 */
export const GuestOpenExternalSchema = z.object({
  type: z.literal('open-external'),
  url: z.string().min(1)
})

export const GuestMetricsSchema = z.object({
  type: z.literal('metrics'),
  /** Content height in CSS px, for native chrome sizing. */
  h: z.number(),
  /** Selection anchor offset from the top of the doc, in CSS px. */
  selAnchor: z.number()
})

/**
 * Where the document is scrolled to, in CSS px from the top.
 *
 * Frame-throttled rather than the 200 ms trailing edge `metrics` uses: the
 * native header rides this value, so a settled-only report would leave it
 * standing still through the gesture and jumping when the finger stops.
 *
 * Unaddressed, like `metrics`: it describes the guest's ONE document, which is
 * whichever note is mounted, and the host routes it to that note's screen.
 */
export const GuestScrollSchema = z.object({
  type: z.literal('scroll'),
  y: z.number()
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
  GuestInsertRequestSchema,
  GuestKeyboardVisibilitySchema,
  GuestEditorPanelVisibilitySchema,
  GuestMarkdownExportSchema,
  GuestHtmlExportSchema,
  GuestNavSchema,
  GuestOpenExternalSchema,
  GuestMetricsSchema,
  GuestScrollSchema,
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
