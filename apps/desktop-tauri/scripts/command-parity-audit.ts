#!/usr/bin/env tsx
/**
 * Command parity audit — classifies every Tauri renderer command and reports
 * gaps relative to Electron's IPC surface.
 *
 * Inputs scanned:
 *   - Electron contract surfaces:
 *       packages/contracts/src/**            (channel constant unions)
 *       apps/desktop/src/preload/**          (preload api shape — not enumerated keys)
 *       apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts (every Electron channel)
 *   - Tauri renderer:
 *       apps/desktop-tauri/src/** literal `invoke('xxx', ...)` calls
 *       apps/desktop-tauri/src/** `createInvokeForwarder<T>('domain')` use
 *   - Tauri mocks:
 *       apps/desktop-tauri/src/lib/ipc/mocks/<domain>.ts route maps
 *   - Real Rust:
 *       apps/desktop-tauri/src-tauri/src/commands/**         (#[tauri::command] fns)
 *       apps/desktop-tauri/src-tauri/src/lib.rs               (generate_handler![])
 *       apps/desktop-tauri/src/generated/bindings.ts          (specta export)
 *
 * Classification per Tauri-renderer command:
 *   - real            — Rust handler + generated binding (production path)
 *   - mocked          — served by mock router until Rust lands
 *   - renderer-only   — invoked by renderer but no mock + no real (FAIL)
 *   - retired         — known deferred name with no live call site
 *   - deferred:<m>    — explicit deferral entry in DEFERRED ledger
 *
 * M2 invariants:
 *   - settings_get / settings_set / settings_list MUST be `real`.
 *   - notify_flush_done MUST be `real` or explicitly `deferred:M8.0`.
 *   - Updater renderer commands (updater_get_state, updater_check_for_updates,
 *     updater_download_update, updater_quit_and_install) MUST have matching
 *     mock routes — old `updater_check`/`updater_download`/`updater_install`
 *     names are forbidden unless listed in DEFERRED.
 *   - No literal renderer invoke can be unclassified.
 */
import { readFileSync, readdirSync, statSync, globSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TAURI_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(TAURI_ROOT, '../..')
const RENDERER_SRC = resolve(TAURI_ROOT, 'src')
const MOCKS_DIR = resolve(RENDERER_SRC, 'lib/ipc/mocks')
const RUST_SRC = resolve(TAURI_ROOT, 'src-tauri/src')
const ELECTRON_INVOKE_MAP = resolve(
  REPO_ROOT,
  'apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts',
)
const BINDINGS_FILE = resolve(RENDERER_SRC, 'generated/bindings.ts')

/**
 * M2 deferral ledger — every renderer literal-invoke that has no mock route
 * yet AND no Rust handler. Tagging each entry with a milestone keeps the
 * carry-forward bookkeeping honest: as later milestones land mocks/Rust
 * handlers, entries here graduate out, and the audit catches new renderer
 * calls that lack any classification.
 *
 * Format: command → milestone string (informational; rendered in report).
 */
const DEFERRED: Record<string, string> = {
  // Logging forwarding lives behind a thin Rust shim in M8.0 lifecycle work.
  logging_forward: 'M8.0',

  // M3 — vault FS + per-domain CRUD that wasn't covered by M1 mocks.
  bookmarks_toggle: 'M3',
  bookmarks_is_bookmarked: 'M3',
  bookmarks_reorder: 'M3',
  inbox_bulk_snooze: 'M3',
  inbox_bulk_tag: 'M3',
  inbox_preview_link: 'M3',
  inbox_track_suggestion: 'M3',
  folder_view_delete_view: 'M3',
  folder_view_folder_exists: 'M3',
  folder_view_get_folder_suggestions: 'M3',
  folder_view_get_views: 'M3',
  folder_view_list_with_properties: 'M3',
  folder_view_set_config: 'M3',
  folder_view_set_view: 'M3',
  graph_get_data: 'M3',
  graph_get_local: 'M3',
  notes_create_folder: 'M3',
  notes_open_external: 'M3',
  notes_reveal_in_finder: 'M3',
  reminders_bulk_dismiss: 'M3',
  reminders_count_pending: 'M3',
  reminders_dismiss: 'M3',
  reminders_get_due: 'M3',
  reminders_get_for_target: 'M3',
  reminders_get_upcoming: 'M3',
  search_add_reason: 'M3',
  search_clear_reasons: 'M3',
  search_get_all_tags: 'M3',
  search_get_reasons: 'M3',
  search_get_stats: 'M3',
  search_quick: 'M3',
  search_rebuild_index: 'M3',
  tags_delete_tag: 'M3',
  tags_merge_tag: 'M3',
  tags_rename_tag: 'M3',
  tags_update_tag_color: 'M3',
  templates_duplicate: 'M3',

  // M3 — sub-domain settings keys carry forward to per-section settings work.
  settings_download_voice_model: 'M3',
  settings_get_ai_model_status: 'M3',
  settings_get_calendar_google_settings: 'M3',
  settings_get_editor_settings: 'M3',
  settings_get_graph_settings: 'M3',
  settings_get_keyboard_settings: 'M3',
  settings_get_note_editor_settings: 'M3',
  settings_get_task_settings: 'M3',
  settings_get_voice_model_status: 'M3',
  settings_get_voice_recording_readiness: 'M3',
  settings_get_voice_transcription_open_ai_key_status: 'M3',
  settings_get_voice_transcription_settings: 'M3',
  settings_load_ai_model: 'M3',
  settings_register_global_capture: 'M3',
  settings_reindex_embeddings: 'M3',
  settings_reset_keyboard_settings: 'M3',
  settings_set_calendar_google_settings: 'M3',
  settings_set_editor_settings: 'M3',
  settings_set_graph_settings: 'M3',
  settings_set_keyboard_settings: 'M3',
  settings_set_note_editor_settings: 'M3',
  settings_set_task_settings: 'M3',
  settings_set_voice_transcription_open_ai_key: 'M3',
  settings_set_voice_transcription_settings: 'M3',

  // M5 — CRDT engine.
  sync_crdt_apply_update: 'M5',
  sync_crdt_close_doc: 'M5',
  sync_crdt_open_doc: 'M5',
  sync_crdt_sync_step1: 'M5',
  sync_crdt_sync_step2: 'M5',

  // M6 — sync ops orchestration.
  sync_ops_get_history: 'M6',
  sync_ops_get_storage_breakdown: 'M6',
  sync_ops_pause: 'M6',
  sync_ops_resume: 'M6',
  sync_ops_trigger_sync: 'M6',

  // M8.0 — lifecycle / native quick-capture window.
  quick_capture_close: 'M8.0',
  quick_capture_get_clipboard: 'M8.0',
  quick_capture_open_settings: 'M8.0',
  quick_capture_resize: 'M8.0',
  show_context_menu: 'M8.0',
}

/** Forbid these legacy renderer/mock names — Phase G rename enforcement. */
const FORBIDDEN_NAMES = new Set<string>(['updater_check', 'updater_download', 'updater_install'])

/**
 * M4 retired/replacement ledger. These Electron crypto channel names existed
 * in the legacy preload surface but have NO live Tauri renderer call site —
 * the M4 plan splits each into a more specific replacement command. Listing
 * them here makes the audit fail loudly if a future change reintroduces the
 * old name as a renderer literal invoke.
 */
const RETIRED: Record<string, string> = {
  crypto_encrypt: 'crypto_encrypt_item',
  crypto_decrypt: 'crypto_decrypt_item',
  crypto_sign: 'internal Rust signing (no renderer-facing replacement); use crypto_verify_signature for verification',
  crypto_verify: 'crypto_verify_signature',
}

/** M2 hard requirements: these MUST resolve to `real`. */
const REQUIRED_REAL = new Set<string>([
  // M2 — settings KV slice
  'settings_get',
  'settings_set',
  'settings_list',

  // M4 — every renderer-facing auth/crypto/linking command must be backed by Rust.
  'sync_auth_request_otp',
  'sync_auth_verify_otp',
  'sync_auth_resend_otp',
  'sync_auth_init_o_auth',
  'sync_auth_refresh_token',
  'sync_auth_logout',
  'sync_setup_setup_first_device',
  'sync_setup_setup_new_account',
  'sync_setup_confirm_recovery_phrase',
  'sync_setup_get_recovery_phrase',
  'sync_devices_get_devices',
  'sync_devices_remove_device',
  'sync_devices_rename_device',
  'sync_linking_generate_linking_qr',
  'sync_linking_link_via_qr',
  'sync_linking_complete_linking_qr',
  'sync_linking_link_via_recovery',
  'sync_linking_get_linking_sas',
  'sync_linking_approve_linking',
  'account_get_recovery_key',
  'crypto_rotate_keys',
])

/** M2 shell-neutral wrappers: real or deferred-with-classification. */
const SHELL_NEUTRAL_REAL_OR_DEFERRED = new Set<string>(['notify_flush_done'])

/** M2 updater renderer surface — every name here MUST be present as a mock. */
const REQUIRED_UPDATER_MOCKS = new Set<string>([
  'updater_get_state',
  'updater_check_for_updates',
  'updater_download_update',
  'updater_quit_and_install',
])

type Classification =
  | { kind: 'real' }
  | { kind: 'mocked' }
  | { kind: 'deferred'; milestone: string }
  | { kind: 'renderer-only' }
  | { kind: 'retired' }

export interface AuditResult {
  rendererCalls: Set<string>
  mockedCommands: Set<string>
  realCommands: Set<string>
  bindingsCommands: Set<string>
  forwarderDomains: Set<string>
  electronChannels: Set<string>
  classifications: Map<string, Classification>
  errors: string[]
  warnings: string[]
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8')
}

function listFilesRec(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const stack: string[] = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const e of entries) {
      const full = resolve(cur, e)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (e === 'node_modules') continue
        stack.push(full)
        continue
      }
      if (exts.some((x) => full.endsWith(x))) out.push(full)
    }
  }
  return out
}

function isProductionFile(path: string): boolean {
  return !/\.test\.(ts|tsx)$/.test(path)
}

/** Extract every literal-string `invoke('cmd', ...)` argument. */
export function extractInvokeLiterals(source: string): string[] {
  const out = new Set<string>()
  const re = /\binvoke\s*(?:<[^>]+>)?\s*\(\s*['"]([a-z][a-z0-9_]+)['"]/g
  for (const m of source.matchAll(re)) out.add(m[1])
  return [...out]
}

/** Extract `createInvokeForwarder<T>('domain')` domain prefixes. */
export function extractForwarderDomains(source: string): string[] {
  const out = new Set<string>()
  const re = /createInvokeForwarder\s*<[^>]+>\s*\(\s*['"]([a-z][a-z0-9_]+)['"]/g
  for (const m of source.matchAll(re)) out.add(m[1])
  return [...out]
}

/**
 * Pull route keys from a mock module. Looks for the `<domain>Routes:
 * MockRouteMap = { ... }` literal and extracts identifier-like keys at the top
 * level. Conservative: only keys with `name: async`, `name: (` or `name,`
 * forms count.
 */
export function extractMockRouteKeys(source: string): string[] {
  const out = new Set<string>()
  const objMatch = source.match(/Routes\s*:\s*MockRouteMap\s*=\s*\{([\s\S]*?)\n\}/)
  if (!objMatch) return []
  const body = objMatch[1]
  let depth = 0
  // Strip nested braces so only top-level keys leak through.
  const flat: string[] = []
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0) flat.push(ch)
  }
  const cleaned = flat.join('')
  const keyRe = /(?:^|[\n,])\s*([a-z][a-z0-9_]+)\s*:/g
  for (const m of cleaned.matchAll(keyRe)) out.add(m[1])
  return [...out]
}

/** Parse `tauri::generate_handler![path::name, ...]` into command names. */
export function extractGenerateHandlerCommands(source: string): string[] {
  const out = new Set<string>()
  const macroMatch = source.match(/generate_handler!\s*\[([\s\S]*?)\]/)
  if (!macroMatch) return []
  const body = macroMatch[1]
  for (const tok of body.split(',')) {
    const trimmed = tok.trim().replace(/[\s;]+$/, '')
    if (!trimmed) continue
    const last = trimmed.split('::').pop()!
    if (/^[a-z][a-z0-9_]+$/.test(last)) out.add(last)
  }
  return [...out]
}

/** Parse `__TAURI_INVOKE("name"` from the specta-generated bindings file. */
export function extractBindingsCommands(source: string): string[] {
  const out = new Set<string>()
  const re = /__TAURI_INVOKE\(\s*"([a-z][a-z0-9_]+)"/g
  for (const m of source.matchAll(re)) out.add(m[1])
  return [...out]
}

/** Pull Electron channel names (kebab-style) from generated-ipc-invoke-map.ts. */
export function extractElectronChannels(source: string): string[] {
  const out = new Set<string>()
  const re = /^\s*"([a-z][a-z0-9-]*:[a-z0-9-]+)"\s*:/gm
  for (const m of source.matchAll(re)) out.add(m[1])
  return [...out]
}

function gatherRendererSurfaces(): {
  invokes: Set<string>
  forwarders: Set<string>
} {
  const files = listFilesRec(RENDERER_SRC, ['.ts', '.tsx']).filter(isProductionFile)
  const invokes = new Set<string>()
  const forwarders = new Set<string>()
  for (const f of files) {
    const src = readUtf8(f)
    for (const c of extractInvokeLiterals(src)) invokes.add(c)
    for (const d of extractForwarderDomains(src)) forwarders.add(d)
  }
  return { invokes, forwarders }
}

function gatherMockCommands(): Set<string> {
  const out = new Set<string>()
  const files = readdirSync(MOCKS_DIR)
    .filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f) && f !== 'types.ts' && f !== 'index.ts')
    .map((f) => resolve(MOCKS_DIR, f))
  for (const f of files) {
    const src = readUtf8(f)
    for (const k of extractMockRouteKeys(src)) out.add(k)
  }
  return out
}

function gatherRealCommands(): { real: Set<string>; bindings: Set<string> } {
  const real = new Set<string>()
  const libRsPath = resolve(RUST_SRC, 'lib.rs')
  if (statSync(libRsPath).isFile()) {
    for (const c of extractGenerateHandlerCommands(readUtf8(libRsPath))) real.add(c)
  }
  const bindings = new Set<string>()
  if (globSync(BINDINGS_FILE).length > 0) {
    for (const c of extractBindingsCommands(readUtf8(BINDINGS_FILE))) bindings.add(c)
  }
  return { real, bindings }
}

function classify(input: {
  rendererCalls: Set<string>
  mocked: Set<string>
  real: Set<string>
}): Map<string, Classification> {
  const out = new Map<string, Classification>()
  for (const cmd of input.rendererCalls) {
    if (input.real.has(cmd)) {
      out.set(cmd, { kind: 'real' })
      continue
    }
    if (DEFERRED[cmd]) {
      out.set(cmd, { kind: 'deferred', milestone: DEFERRED[cmd] })
      continue
    }
    if (input.mocked.has(cmd)) {
      out.set(cmd, { kind: 'mocked' })
      continue
    }
    out.set(cmd, { kind: 'renderer-only' })
  }
  // Mock-only entries (no renderer call site) — useful for catching dead routes
  // but not failing.
  for (const cmd of input.mocked) {
    if (out.has(cmd)) continue
    out.set(cmd, { kind: 'mocked' })
  }
  // Deferred entries that may not be called by renderer yet (e.g. logging_forward).
  for (const cmd of Object.keys(DEFERRED)) {
    if (out.has(cmd)) continue
    out.set(cmd, { kind: 'deferred', milestone: DEFERRED[cmd] })
  }
  // Retired entries surface as `retired` in the summary even when there is
  // no live renderer call (the expected steady state).
  for (const cmd of Object.keys(RETIRED)) {
    if (out.has(cmd)) continue
    out.set(cmd, { kind: 'retired' })
  }
  return out
}

export function runAudit(): AuditResult {
  const { invokes, forwarders } = gatherRendererSurfaces()
  const mocked = gatherMockCommands()
  const { real, bindings } = gatherRealCommands()
  const electron = (() => {
    try {
      return new Set(extractElectronChannels(readUtf8(ELECTRON_INVOKE_MAP)))
    } catch {
      return new Set<string>()
    }
  })()

  const classifications = classify({ rendererCalls: invokes, mocked, real })
  const errors: string[] = []
  const warnings: string[] = []

  for (const cmd of REQUIRED_REAL) {
    const c = classifications.get(cmd)
    if (!c || c.kind !== 'real') {
      errors.push(`required-real "${cmd}" is ${c?.kind ?? 'absent'} (M2 invariant)`)
    }
    if (!bindings.has(cmd)) {
      errors.push(`required-real "${cmd}" missing from generated bindings`)
    }
  }

  for (const cmd of SHELL_NEUTRAL_REAL_OR_DEFERRED) {
    const c = classifications.get(cmd)
    if (!c) {
      errors.push(`shell-neutral wrapper "${cmd}" not found in any surface`)
      continue
    }
    if (c.kind === 'real') continue
    if (c.kind === 'deferred') continue
    errors.push(
      `shell-neutral wrapper "${cmd}" must be real or deferred, got ${c.kind}`,
    )
  }

  for (const cmd of REQUIRED_UPDATER_MOCKS) {
    if (!mocked.has(cmd) && !real.has(cmd)) {
      errors.push(`updater renderer surface "${cmd}" missing from mocks and real handlers`)
    }
  }

  for (const cmd of FORBIDDEN_NAMES) {
    if (mocked.has(cmd)) {
      errors.push(`forbidden legacy mock route "${cmd}" still registered`)
    }
    if (invokes.has(cmd)) {
      errors.push(`forbidden legacy command "${cmd}" still invoked from renderer`)
    }
  }

  for (const [cmd, replacement] of Object.entries(RETIRED)) {
    if (invokes.has(cmd)) {
      errors.push(
        `retired command "${cmd}" reappeared as a renderer literal invoke — use "${replacement}" instead`,
      )
    }
    if (mocked.has(cmd)) {
      errors.push(
        `retired command "${cmd}" still registered as a mock route — use "${replacement}" instead`,
      )
    }
  }

  for (const [cmd, c] of classifications) {
    if (c.kind === 'renderer-only') {
      errors.push(`unclassified renderer command "${cmd}" — add a mock or deferral entry`)
    }
  }

  // Forwarder domains MUST have a corresponding mock module (the forwarder
  // proxies any method on the domain to invoke('domain_method'), so without a
  // mock module those calls 404 at runtime).
  for (const domain of forwarders) {
    const mockFile = resolve(MOCKS_DIR, `${domain.replace(/_/g, '-')}.ts`)
    const altFile = resolve(MOCKS_DIR, `${domain}.ts`)
    if (!fileExists(mockFile) && !fileExists(altFile)) {
      warnings.push(
        `forwarder domain "${domain}" has no mocks/${domain}.ts module — runtime 404 risk`,
      )
    }
  }

  // Mock routes that don't correspond to any Tauri renderer call site or
  // Rust command — informational, not failure.
  for (const cmd of mocked) {
    if (real.has(cmd)) continue
    if (invokes.has(cmd)) continue
    // A mock keyed by a forwarder method call name like `tasks_list` is
    // exercised through the forwarder proxy; presence of the matching
    // forwarder domain is enough to consider it live.
    const domainPrefix = [...forwarders].find((d) => cmd.startsWith(`${d}_`) || cmd === d)
    if (domainPrefix) continue
    warnings.push(`mock route "${cmd}" has no renderer call site or forwarder domain`)
  }

  return {
    rendererCalls: invokes,
    mockedCommands: mocked,
    realCommands: real,
    bindingsCommands: bindings,
    forwarderDomains: forwarders,
    electronChannels: electron,
    classifications,
    errors,
    warnings,
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function summarize(result: AuditResult): void {
  const counts = { real: 0, mocked: 0, deferred: 0, 'renderer-only': 0, retired: 0 }
  for (const c of result.classifications.values()) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1
  }

  console.log('Command parity audit')
  console.log('--------------------')
  console.log(`Renderer literal invokes : ${result.rendererCalls.size}`)
  console.log(`Forwarder domains        : ${result.forwarderDomains.size}`)
  console.log(`Mock routes              : ${result.mockedCommands.size}`)
  console.log(`Rust real commands       : ${result.realCommands.size}`)
  console.log(`Generated bindings       : ${result.bindingsCommands.size}`)
  console.log(`Electron channels (ref)  : ${result.electronChannels.size}`)
  console.log('')
  console.log(
    `Classifications: real=${counts.real} mocked=${counts.mocked} ` +
      `deferred=${counts.deferred} renderer-only=${counts['renderer-only']} ` +
      `retired=${counts.retired}`,
  )

  if (result.warnings.length) {
    console.log('\nWarnings:')
    for (const w of result.warnings) console.log(`  • ${w}`)
  }
  if (result.errors.length) {
    console.log('\nErrors:')
    for (const e of result.errors) console.log(`  ✘ ${e}`)
  }
}

function main(): void {
  const result = runAudit()
  summarize(result)
  if (result.errors.length > 0) {
    console.log(`\nFAIL: ${result.errors.length} error(s) — see above.`)
    process.exit(1)
  }
  console.log('\nOK: command parity audit clean.')
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  main()
}
