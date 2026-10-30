// Regenerates electron-vault/config-json.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-config-vectors.mjs
// Each case starts a vault folder (empty, or holding a config an older build left) and calls
// Electron's own writers of `.memry/config.json` in turn (`initVault`, `writeVaultConfig`,
// `writePreferences`, `writeVaultIcon`). After every step the vector holds the bytes on disk and
// what Electron's readers make of them (`readVaultConfig`, `hasStoredPreferences`,
// `readPreferences`), so the Rust readers and writers are checked against files Electron wrote.
//
// It also fills in electron-vault/config-json-ours.json: the files the Rust build wrote for the
// same steps (written by `MEMRY_UPDATE_CONFIG_VECTORS=1 cargo test -p memry-desktop --test
// config_compat`, run first), each with what Electron's readers make of it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const init = await load('../../../../apps/desktop/src/main/vault/init.ts')
const prefs = await load('../../../../apps/desktop/src/main/vault/vault-preferences.ts')
const icon = await load('../../../../apps/desktop/src/main/vault/vault-icon.ts')

console.log = console.warn = console.info = console.debug = () => {}

const CONFIG_KEYS = [
  'excludePatterns',
  'defaultNoteFolder',
  'journalFolder',
  'journalDateFormat',
  'attachmentsFolder',
  'journalShowInSidebar'
]

/** What a build before color themes, the font-size slider and the vault icon left, with keys
 *  only a newer build knows at the top level, in `preferences` and in `editor`. */
const OLDER_BUILD = `{
  "excludePatterns": [
    ".git",
    "node_modules"
  ],
  "journalFolder": "diary",
  "preferences": {
    "theme": "light",
    "fontSize": "large",
    "language": "de",
    "editor": {
      "width": "wide",
      "spellCheck": false,
      "newerEditorKey": 3
    },
    "newerPreference": {
      "z": 1,
      "a": 2
    }
  },
  "newerBuild": [
    1,
    2
  ]
}`

const steps = {
  init: (vault) => init.initVault(vault),
  config: (vault, patch) => init.writeVaultConfig(vault, patch),
  preferences: (vault, updates) => prefs.writePreferences(vault, updates),
  icon: (vault, stored) => icon.writeVaultIcon(vault, stored)
}

const CASES = [
  {
    name: 'init-then-every-writer',
    start: null,
    steps: [
      ['init'],
      ['config', { journalFolder: 'daily', journalShowInSidebar: true }],
      ['preferences', { theme: 'dark', fontSizePx: 18, editor: { width: 'full' } }],
      ['icon', { value: 'icon:Book01Icon', updatedAt: 40, pendingSync: true }],
      ['config', { defaultNoteFolder: 'inbox', excludePatterns: ['.git', 'build'] }],
      ['preferences', { language: 'tr', editor: { toolbarMode: 'sticky' } }],
      // The slider writes the pair; 15 px is the small bucket (a tie goes to the smaller).
      ['preferences', { fontSizePx: 15, fontSize: 'small' }],
      ['icon', { value: null, updatedAt: 41, pendingSync: false }]
    ]
  },
  {
    name: 'older-build',
    start: OLDER_BUILD,
    steps: [
      ['config', { defaultNoteFolder: 'notes' }],
      ['icon', { value: '📚', updatedAt: 7, pendingSync: false }],
      ['preferences', { accentColor: '#112233' }]
    ]
  },
  {
    name: 'older-build-preferences-first',
    start: OLDER_BUILD,
    steps: [
      ['preferences', { theme: 'dark' }],
      ['config', { journalDateFormat: 'DD-MM-YYYY' }],
      ['preferences', { openPagesInNewTab: true, editor: { width: 'normal' } }]
    ]
  }
]

function readBack(vault) {
  init.invalidateVaultConfigCache()
  const config = init.readVaultConfig(vault)
  const stored = prefs.hasStoredPreferences(vault)
  return {
    config: Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key]])),
    hasStoredPreferences: stored,
    preferences: stored ? prefs.readPreferences(vault) : null
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const oursPath = join(here, 'electron-vault', 'config-json-ours.json')
const ours = existsSync(oursPath) ? JSON.parse(readFileSync(oursPath, 'utf8')) : null
const root = mkdtempSync(join(tmpdir(), 'memry-config-vectors-'))
const cases = []
try {
  for (const c of CASES) {
    const vault = join(root, c.name)
    mkdirSync(join(vault, '.memry'), { recursive: true })
    if (c.start !== null) writeFileSync(join(vault, '.memry', 'config.json'), c.start)
    const recorded = []
    for (const [kind, arg] of c.steps) {
      steps[kind](vault, arg)
      recorded.push({
        kind,
        arg: arg ?? null,
        file: readFileSync(join(vault, '.memry', 'config.json'), 'utf8'),
        read: readBack(vault)
      })
    }
    cases.push({ name: c.name, start: c.start, steps: recorded })
  }
  for (const [n, step] of (ours?.steps ?? []).entries()) {
    const vault = join(root, `ours-${n}`)
    mkdirSync(join(vault, '.memry'), { recursive: true })
    writeFileSync(join(vault, '.memry', 'config.json'), step.file)
    step.read = readBack(vault)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (ours) writeFileSync(oursPath, JSON.stringify(ours, null, 2) + '\n')
writeFileSync(
  join(here, 'electron-vault', 'config-json.json'),
  JSON.stringify(
    {
      generator: 'crates/memry-desktop/tests/fixtures/gen-config-vectors.mjs',
      preferenceDefaults: prefs.VAULT_PREFERENCES_DEFAULTS,
      cases
    },
    null,
    2
  ) + '\n'
)
