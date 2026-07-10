import path from 'path'

const EXTERNAL_URL_ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/**
 * Whether a URL is safe to hand to `shell.openExternal`. Only web/mail schemes
 * are allowed so renderer-triggered `window.open` cannot launch arbitrary
 * protocols (file:, smb:, custom handlers) via the OS.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return EXTERNAL_URL_ALLOWED_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

/**
 * Resolves a memry-file://local/<absolute path> URL to its absolute filesystem
 * path using the same decoding rules as the memry-file protocol handler.
 * Returns null for anything that is not a valid memry-file URL.
 */
export function resolveMemryFilePath(
  rawUrl: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'memry-file:') return null

    let filePath = decodeURIComponent(url.pathname)
    const pathModule = platform === 'win32' ? path.win32 : path.posix
    if (platform === 'win32') {
      if (filePath.startsWith('/')) filePath = filePath.slice(1)
    } else if (!filePath.startsWith('/')) {
      filePath = '/' + filePath
    }

    return pathModule.resolve(pathModule.normalize(filePath))
  } catch {
    return null
  }
}

/**
 * Whether an absolute path is one of the given directories or inside one,
 * using the platform's separator so Windows backslash paths match correctly.
 */
export function isPathInsideDirs(
  filePath: string,
  dirs: string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  return dirs.some((dir) => {
    const resolvedDir = pathModule.resolve(dir)
    return filePath === resolvedDir || filePath.startsWith(resolvedDir + pathModule.sep)
  })
}
