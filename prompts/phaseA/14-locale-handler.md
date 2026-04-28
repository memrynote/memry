# Task 14: Implement main-process locale IPC handler (TDD)

> **Plan:** Task 14 (Implement `apps/desktop/src/main/ipc/locale-handler.ts`)
> **Depends on:** Tasks 10 (createMainI18n), 13 (LocaleChannels)
> **Dependents:** Task 15 (boot wiring registers this), Task 21 (preload bridge invokes these channels)

## Pre-flight check

```bash
pwd                                                                     # ../memry-i18n-phase-a
git status                                                              # clean
ls apps/desktop/src/main/ipc/                                           # see existing handlers
cat apps/desktop/src/main/ipc/index.ts | head -40                       # see registration pattern
grep -rn "getGeneralSettings\|updateGeneralSettings" apps/desktop/src/main/ | head -10  # find settings store API
```

Note the actual settings-store function names from the grep — they might be different from the spec's placeholder names. Adapt your import paths accordingly.

## Your job

Implement `registerLocaleHandlers(i18n, rebuildMenu)` that:

1. Registers three `ipcMain.handle` channels: `Get`, `Set`, `List`
2. On `Set`: persists to settings → calls `i18n.changeLanguage` → rebuilds native menu → broadcasts `Changed` to all windows
3. Tracks active locale in module-level state for the `Get` channel

## Steps

1. **Write the test** — `apps/desktop/src/main/ipc/locale-handler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('@memry/i18n/main', () => ({
  createMainI18n: vi.fn(),
  loadResources: vi.fn()
}))

import { ipcMain } from 'electron'
import { registerLocaleHandlers } from './locale-handler'

describe('locale handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers get, set, list channels', () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:get', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:set', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:list', expect.any(Function))
  })

  it('rejects an invalid locale string', async () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([ch]: [string]) => ch === 'locale:set'
    )[1]
    await expect(setHandler({}, 'invalid' as any)).rejects.toThrow()
  })
})
```

2. **Run test to verify it fails**:

```bash
pnpm --filter @memry/desktop test locale-handler
```

Expected: FAIL — module not found.

3. **Implement `apps/desktop/src/main/ipc/locale-handler.ts`**:

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import { LocaleSchema, SUPPORTED_LOCALES, type Locale } from '@memry/contracts/locale-api'
import type { I18nInstance } from '@memry/i18n/main'
import { createLogger } from '../lib/logger'
// Replace the next two imports with the actual settings-store function names from your grep
import { getGeneralSettings, updateGeneralSettings } from '../store/settings-store'

const logger = createLogger('Locale')

export type RebuildMenuFn = (locale: Locale) => void

let activeLocale: Locale = 'en'

export function getActiveLocale(): Locale {
  return activeLocale
}

export function registerLocaleHandlers(
  i18n: I18nInstance,
  rebuildMenu: RebuildMenuFn
): void {
  activeLocale = i18n.language as Locale

  ipcMain.handle(LocaleChannels.Get, () => activeLocale)

  ipcMain.handle(LocaleChannels.List, () => SUPPORTED_LOCALES)

  ipcMain.handle(LocaleChannels.Set, async (_event, candidate: unknown): Promise<void> => {
    const locale = LocaleSchema.parse(candidate)
    if (locale === activeLocale) return

    logger.info('Changing locale', { from: activeLocale, to: locale })

    try {
      // 1. Persist to settings
      const current = await getGeneralSettings()
      await updateGeneralSettings({ ...current, language: locale })

      // 2. Update main-process i18next
      await i18n.changeLanguage(locale)

      // 3. Rebuild native menu
      rebuildMenu(locale)

      // 4. Broadcast to all renderer windows
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(LocaleChannels.Changed, locale)
      }

      activeLocale = locale
      logger.info('Locale changed', { locale })
    } catch (err) {
      logger.error('Locale change failed', { locale, error: err })
      throw err
    }
  })
}
```

**If your `getGeneralSettings`/`updateGeneralSettings` import path is different**, adjust it. The mock in the test stubs those calls to no-ops anyway, so test passes regardless.

4. **Run test**:

```bash
pnpm --filter @memry/desktop test locale-handler
```

Expected: 2 tests pass. If the test fails because the store module isn't mocked, add a `vi.mock` for the actual store module path:

```ts
vi.mock('../store/settings-store', () => ({
  getGeneralSettings: vi.fn(() => Promise.resolve({})),
  updateGeneralSettings: vi.fn()
}))
```

5. **Register the handler in the main IPC index** — edit `apps/desktop/src/main/ipc/index.ts`. Look at how other handlers are registered. The pattern is likely a `registerAllHandlers()` function. We need to refactor it minimally to accept the i18n instance and a `rebuildMenu` callback:

```ts
import { registerLocaleHandlers, type RebuildMenuFn } from './locale-handler'
import type { I18nInstance } from '@memry/i18n/main'

interface IpcDeps {
  i18n: I18nInstance
  rebuildMenu: RebuildMenuFn
}

export function registerAllHandlers(deps: IpcDeps): void {
  // ...existing registrations remain unchanged...
  registerLocaleHandlers(deps.i18n, deps.rebuildMenu)
}
```

The single caller (in `apps/desktop/src/main/index.ts`) must be updated to pass `{ i18n, rebuildMenu }`. Don't change that yet — Task 15 wires it.

6. **Commit**:

```bash
git add apps/desktop/src/main/ipc/locale-handler.ts apps/desktop/src/main/ipc/locale-handler.test.ts apps/desktop/src/main/ipc/index.ts
git commit -m "feat(i18n): add main-process locale IPC handler"
```

## Exit criteria

- [ ] `locale-handler.ts` exists with `registerLocaleHandlers` and `getActiveLocale`
- [ ] `locale-handler.test.ts` exists with at least 2 tests passing
- [ ] `apps/desktop/src/main/ipc/index.ts` updated to call `registerLocaleHandlers` from inside `registerAllHandlers`
- [ ] Tests pass
- [ ] One commit

## Skills to use

- **`superpowers:test-driven-development`** — required
- **`superpowers:verification-before-completion`** — confirm tests pass

## Report back

```
✅ Task 14 complete.
Commit SHA: <abbrev>
Tests: <N> pass
Settings store API used: <actual function names>
Next: Task 15 (main process boot wiring)
```
