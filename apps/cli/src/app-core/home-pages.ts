import { asc, eq } from 'drizzle-orm'
import { homePages, type HomePageRow } from '@memry/db-schema/schema/home-pages'
import type { HomePage, WidgetInstance } from '@memry/contracts/home-page-api'
import type { DataDb } from './database.ts'

// Read-only mirror of desktop's home-page reads (apps/desktop/src/main/ipc/
// home-page-handlers.ts `rowToHomePage`, database/queries/home-pages.ts).
// Widgets and covers are edited in the desktop app only.

// Legacy span (S/M/L) -> grid coords, for boards saved before the resizable-grid migration.
const LEGACY_SPAN: Record<string, { w: number; h: number }> = {
  S: { w: 2, h: 2 },
  M: { w: 4, h: 4 },
  L: { w: 8, h: 4 }
}

export interface HomePagesService {
  list(): Promise<HomePage[]>
  get(id: string): Promise<HomePage | null>
}

// An unparseable blob degrades the one bad board to empty instead of failing the whole list.
function parseWidgets(row: HomePageRow): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(row.widgets) as unknown
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON or driver result; shape fixed by the producer, a runtime parser would change accepted input
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
  } catch {
    return []
  }
}

function rowToHomePage(row: HomePageRow): HomePage {
  let y = 0
  const widgets = parseWidgets(row).map((widget): WidgetInstance => {
    if (
      typeof widget.x === 'number' &&
      typeof widget.y === 'number' &&
      typeof widget.w === 'number' &&
      typeof widget.h === 'number'
    ) {
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- partial value cast through its boundary type; precise type is not available
      return widget as unknown as WidgetInstance
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
    const span = LEGACY_SPAN[widget.size as string] ?? LEGACY_SPAN.M
    const migrated: WidgetInstance = {
      id: String(widget.id),
      type: String(widget.type),
      x: 0,
      y,
      w: span.w,
      h: span.h,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
      config: (widget.config as Record<string, unknown>) ?? {}
    }
    y += span.h
    return migrated
  })
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    position: row.position,
    widgets,
    ...(row.cover ? { cover: row.cover } : {})
  }
}

export function createHomePagesService(dataDb: DataDb): HomePagesService {
  return {
    async list() {
      // The id tiebreak keeps ties in one order on every device, as on desktop.
      return dataDb
        .select()
        .from(homePages)
        .orderBy(asc(homePages.position), asc(homePages.createdAt), asc(homePages.id))
        .all()
        .map(rowToHomePage)
    },
    async get(id) {
      const row = dataDb.select().from(homePages).where(eq(homePages.id, id)).get()
      return row ? rowToHomePage(row) : null
    }
  }
}
