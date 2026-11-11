import { existsSync, realpathSync } from 'node:fs'

import { invokeTest } from './invoke-test'

type App = Parameters<typeof invokeTest>[0]

/**
 * What the app handed the OS, as `reveal <file>` or `path <file>`, each file named by its real
 * path. The app hands over a canonical path, which is `\\?\`-prefixed on Windows and under
 * `/private` on macOS.
 */
export async function osOpens(app: App): Promise<string[]> {
  const opens = await invokeTest<string[]>(app, 'e2e_os_opens')
  return opens.map((entry) => {
    const [kind, ...rest] = entry.split(' ')
    return `${kind} ${realFile(rest.join(' ').replace(/^\\\\\?\\/, ''))}`
  })
}

export const realFile = (path: string): string =>
  existsSync(path) ? realpathSync.native(path) : `missing ${path}`
