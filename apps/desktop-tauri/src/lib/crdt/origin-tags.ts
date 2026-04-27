let cachedOrigin: number | null = null

export function createRendererOrigin(): number {
  if (cachedOrigin !== null) return cachedOrigin

  const seedSource =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  cachedOrigin = (Math.floor((seedSource * 1_000_003) % 0xfff_ffff) | 1) >>> 0
  return cachedOrigin
}

export function isRendererOrigin(value: unknown): boolean {
  return typeof value === 'number' && value === createRendererOrigin()
}
