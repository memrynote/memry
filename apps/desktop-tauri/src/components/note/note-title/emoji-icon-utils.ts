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
