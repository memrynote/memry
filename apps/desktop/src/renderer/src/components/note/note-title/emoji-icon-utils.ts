export const ICON_PREFIX = 'icon:'

export function isIconValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ICON_PREFIX)
}

export function parseIconName(value: string): string {
  return value.slice(ICON_PREFIX.length)
}

export function toIconValue(iconName: string): string {
  return `${ICON_PREFIX}${iconName}`
}

/**
 * A user-uploaded image icon, stored at `<vault>/.memry/icons/<id>.<ext>`.
 *
 * Only the id travels in the icon value — the extension and display name live
 * on the synced `custom_icons` row, so renaming or re-encoding an icon never
 * has to rewrite every folder/note that points at it.
 */
export const CUSTOM_ICON_PREFIX = 'custom:'

export function isCustomIconValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CUSTOM_ICON_PREFIX)
}

export function parseCustomIconId(value: string): string {
  return value.slice(CUSTOM_ICON_PREFIX.length)
}

export function toCustomIconValue(id: string): string {
  return `${CUSTOM_ICON_PREFIX}${id}`
}
