// Vault-level state outside the notes: the icon in `.memry/config.json`, the device-local
// activity log, and read-only locks. Mirrors the desktop readers/writers named at each function.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { VaultActivityEntry, VaultActivityFilter } from '@memry/contracts/vault-activity-api'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import type { DataDb } from './database.ts'
import { getConfigPath, getMemryDir } from './paths.ts'
import { errorCode } from './errno.ts'

export interface ActivityListOptions {
  limit?: number
  filter?: VaultActivityFilter
}

export interface VaultLockList {
  notes: string[]
  folders: string[]
}

export interface VaultAdminService {
  setIcon(icon: string | null): Promise<{ icon: string | null }>
  listActivity(options?: ActivityListOptions): Promise<VaultActivityEntry[]>
  clearActivity(): Promise<{ cleared: true }>
  listLocks(): VaultLockList
}

// Node's type stripping cannot load the zod schemas behind these contracts (extensionless
// imports), so the two checks they make are mirrored here. Sources:
// VaultIconSchema in packages/contracts/src/vault-api.ts and VAULT_ACTIVITY_FILTERS and
// VaultActivityEntrySchema in packages/contracts/src/vault-activity-api.ts.
function isValidVaultIcon(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false
  return value.startsWith('icon:')
    ? /^icon:[A-Za-z0-9]+$/.test(value)
    : !value.startsWith('custom:') && value.length <= 32 && !/[\s\p{Cc}]/u.test(value)
}

const activityFilters: ReadonlySet<VaultActivityFilter> = new Set(['all', 'problems'])

function isActivityEntry(value: unknown): value is VaultActivityEntry {
  if (!value || typeof value !== 'object') return false
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
  const entry = value as Record<string, unknown>
  return (
    entry.v === 1 &&
    typeof entry.id === 'string' &&
    entry.id !== '' &&
    typeof entry.at === 'string' &&
    entry.at !== '' &&
    typeof entry.kind === 'string' &&
    typeof entry.source === 'string'
  )
}

const ACTIVITY_FILE = 'activity.jsonl'
const DEFAULT_ACTIVITY_LIMIT = 200

// apps/desktop/src/main/vault/activity-log.ts `isProblem`.
function isProblem(entry: VaultActivityEntry): boolean {
  if (entry.kind === 'skipped' || entry.kind === 'failed') return true
  const counts = entry.counts
  if (!counts) return false
  return (counts.failed ?? 0) > 0 || (counts.skipped ?? 0) > 0 || (counts.unsupported ?? 0) > 0
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true })
    throw error
  }
}

export function createVaultAdminService({
  vaultPath,
  dataDb
}: {
  vaultPath: string
  dataDb: DataDb
}): VaultAdminService {
  const activityPath = path.join(getMemryDir(vaultPath), ACTIVITY_FILE)

  return {
    // apps/desktop/src/main/vault/vault-icon.ts: a top-level `vaultIcon` key, changed
    // strictly after its stored change time and left `pendingSync` for desktop to push.
    async setIcon(icon) {
      if (icon !== null && !isValidVaultIcon(icon)) {
        throw new Error(`Invalid vault icon: ${icon} (use icon:<Name> or a single emoji)`)
      }
      const configPath = getConfigPath(vaultPath)
      let existing: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf-8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object')
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
        existing = parsed as Record<string, unknown>
      } catch (error) {
        // Rewriting an unreadable config would lose the user's settings.
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Cannot read ${configPath} (${reason}); vault icon not changed`, {
          cause: error
        })
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
      const previous = existing.vaultIcon as { updatedAt?: unknown } | undefined
      const previousAt = typeof previous?.updatedAt === 'number' ? previous.updatedAt : 0
      const updatedAt = Math.max(Date.now(), previousAt + 1)
      await writeFileAtomic(
        configPath,
        `${JSON.stringify({ ...existing, vaultIcon: { value: icon, updatedAt, pendingSync: true } }, null, 2)}\n`
      )
      return { icon }
    },

    // Newest first; a line this build cannot parse is dropped, as desktop's reader does.
    async listActivity({ limit = DEFAULT_ACTIVITY_LIMIT, filter = 'all' } = {}) {
      if (!activityFilters.has(filter)) throw new Error(`Invalid activity filter: ${filter}`)
      let content: string
      try {
        content = await fs.readFile(activityPath, 'utf-8')
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return []
        throw error
      }
      const entries: VaultActivityEntry[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isActivityEntry(parsed)) entries.push(parsed)
        } catch {
          // Unparseable line: dropped, like desktop's reader.
        }
      }
      return entries
        .toReversed()
        .filter((entry) => filter !== 'problems' || isProblem(entry))
        .slice(0, limit)
    },

    // An empty log; desktop's own `clearActivity` empties it the same way.
    async clearActivity() {
      try {
        await fs.access(activityPath)
      } catch {
        return { cleared: true }
      }
      await writeFileAtomic(activityPath, '')
      return { cleared: true }
    },

    listLocks() {
      const rows = dataDb.select().from(vaultLocks).where(eq(vaultLocks.locked, true)).all()
      return {
        notes: rows.filter((row) => row.targetKind === 'note').map((row) => row.target),
        folders: rows.filter((row) => row.targetKind === 'folder').map((row) => row.target)
      }
    }
  }
}
