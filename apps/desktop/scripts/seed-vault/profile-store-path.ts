import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Note CRDT state is not in the vault. The app keeps it in a y-leveldb store
// under Electron's userData, one store per vault:
//
//   <userData>/crdt-stores/<vaultUuid>        (src/main/sync/crdt-store-path.ts)
//
// and `CrdtProvider.doOpen` loads a note's doc from there before it would
// seed one from the markdown file. userData is per profile, so a doc written
// here is only seen by the profile it was written for; any other profile
// opens the vault with no stored doc and re-seeds the note from markdown.
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
/** What `app.getAppPath()` answers under `electron-vite dev`: the desktop package root. */
const DESKTOP_APP_PATH = resolve(__dirname, '..', '..')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Electron's `appData` for this platform. */
function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

/**
 * The device id `pnpm dev` runs under for this checkout. Mirrors
 * `resolveDeviceId` in src/main/index.ts: `MEMRY_DEVICE=dev` becomes
 * `dev-<first 8 hex of sha256(app path)>`, so each worktree gets its own profile.
 */
export function defaultDevProfile(): string {
  const hash = createHash('sha256').update(normalize(DESKTOP_APP_PATH)).digest('hex').slice(0, 8)
  return `dev-${hash}`
}

/**
 * userData for a dev profile. src/main/index.ts renames the app to
 * `memry-<id>` and then appends `-<id>` to the userData that name yields, so
 * `MEMRY_DEVICE=A` lives in `<appData>/memry-A-A`.
 */
export function devProfileUserData(deviceId: string): string {
  return join(appDataDir(), `memry-${deviceId}-${deviceId}`)
}

/** Same layout as `vaultCrdtStorePath` (a canonical uuid is used verbatim, lower-cased). */
export function vaultCrdtStoreDir(userDataDir: string, vaultUuid: string): string {
  const normalized = vaultUuid.trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Seeded vault uuid is not a canonical uuid: ${vaultUuid}`)
  }
  return join(userDataDir, 'crdt-stores', normalized)
}
