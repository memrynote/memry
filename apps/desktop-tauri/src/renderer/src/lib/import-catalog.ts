import { Import } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons/types'

/**
 * Per-importer icon override, keyed by importer id. Importer metadata (name,
 * description, file spec, preview capability) comes from the registry over IPC;
 * only the icon is renderer-side. Missing ids fall back to DEFAULT_IMPORT_ICON.
 */
export const IMPORT_ICONS: Record<string, AppIcon> = {}

export const DEFAULT_IMPORT_ICON: AppIcon = Import
