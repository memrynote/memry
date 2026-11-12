import { realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_RADIX = path.resolve(import.meta.dirname, '../../../../../node_modules/@radix-ui')

// Radix keeps its layer and focus stacks in module-level state. A Popover whose
// DismissableLayer is a different copy from its Dialog's cannot see the Dialog's
// `pointer-events: none` body lock, so it inherits it and every click on a
// swatch, option, or button inside it falls through to the Dialog beneath.
const USERS_BY_SHARED_STATE: Record<string, string[]> = {
  'react-dismissable-layer': [
    'react-dialog',
    'react-popover',
    'react-select',
    'react-tooltip',
    'react-hover-card'
  ],
  'react-focus-scope': ['react-dialog', 'react-popover', 'react-select']
}

// pnpm links each package's dependencies as siblings of its real directory.
const resolveFrom = (pkg: string, dep: string): string => {
  const pkgRoot = realpathSync(path.join(DESKTOP_RADIX, pkg))
  return realpathSync(path.join(path.dirname(pkgRoot), dep))
}

describe('Radix layer stack', () => {
  it.each(Object.entries(USERS_BY_SHARED_STATE))('resolves one %s for every user', (dep, users) => {
    const resolved = new Set(users.map((pkg) => resolveFrom(pkg, dep)))
    expect([...resolved]).toHaveLength(1)
  })
})
