import { createLogger } from '@/lib/logger'

export const SIDEBAR_WIDTH_DEFAULT_PX = 256
export const SIDEBAR_STORAGE_KEY = 'sidebar_width'
export const SIDEBAR_OPEN_STORAGE_KEY = 'sidebar_open'

const log = createLogger('Sidebar')

/**
 * Open state and width are one preference for the window, not per provider.
 * Each kept vault workspace mounts its own SidebarProvider; with private state
 * a collapse or resize in one vault was undone by revealing another. The value
 * lives in localStorage; `liveWidth` carries the width while a resize drag is
 * in progress, which is only persisted once it ends.
 */
const layoutListeners = new Set<() => void>()
let liveWidth: number | null = null
/** The open flag when storage refused it, so the toggle still works this session. */
let unpersistedOpen: boolean | null = null

export function subscribeSidebarLayout(listener: () => void): () => void {
  layoutListeners.add(listener)
  return () => {
    layoutListeners.delete(listener)
  }
}

function emitSidebarLayout(): void {
  for (const listener of [...layoutListeners]) listener()
}

/** The stored open flag, or null when none was ever stored. */
export function getStoredSidebarOpen(): boolean | null {
  if (unpersistedOpen !== null) return unpersistedOpen
  try {
    const stored = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)
    return stored === null ? null : stored === 'true'
  } catch (error) {
    log.error('Failed to read the sidebar open state', error)
    return null
  }
}

export function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
    unpersistedOpen = null
  } catch (error) {
    log.error('Failed to persist the sidebar open state', error)
    unpersistedOpen = open
  }
  emitSidebarLayout()
}

export function getSidebarWidth(): number {
  if (liveWidth !== null) return liveWidth
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
    return stored ? Number(stored) : SIDEBAR_WIDTH_DEFAULT_PX
  } catch {
    return SIDEBAR_WIDTH_DEFAULT_PX
  }
}

export function setLiveSidebarWidth(width: number): void {
  if (width === getSidebarWidth()) return
  liveWidth = width
  emitSidebarLayout()
}

export function persistSidebarWidth(): void {
  if (liveWidth === null) return
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(liveWidth))
    liveWidth = null
  } catch {
    /* localStorage unavailable: keep the in-memory width */
  }
}
