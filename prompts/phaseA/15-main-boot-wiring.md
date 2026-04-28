# Task 15: Wire main-process boot sequence (i18n → menu → handlers → window)

> **Plan:** Task 15 (Wire Main-Process Boot Sequence)
> **Depends on:** Task 14 (handler exists, ready to register)
> **Dependents:** Task 16 (menu uses `t()`), Task 21 (renderer asks main for locale)

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
grep -n "whenReady\|registerAllHandlers\|setApplicationMenu" apps/desktop/src/main/index.ts | head -10
```

This shows the exact lines where the existing boot sequence happens. Identify these key points:

- (a) Where settings are loaded
- (b) Where `registerAllHandlers` is called
- (c) Where the first BrowserWindow is created
- (d) Where the native menu is set (likely `Menu.setApplicationMenu(...)`)

## Your job

Boot the main-process i18next instance **before** the menu builds and **before** handlers are registered. Resolve initial locale from persisted settings (fallback to `'en'` if absent or unparseable). The instance is captured in module scope so the `rebuildMenu` callback can read it.

This task is the most "adapt to existing structure" of Phase A — read the existing boot order carefully and slot the new code in correctly.

## Steps

1. **Read the current boot flow** in `apps/desktop/src/main/index.ts` around the `app.whenReady()` block:

```bash
sed -n '/app.whenReady/,/registerAllHandlers/p' apps/desktop/src/main/index.ts | head -60
```

2. **Add imports** at the top of `apps/desktop/src/main/index.ts`:

```ts
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'
import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'
import { buildAppMenu } from './menu'  // Task 16 creates this if it doesn't exist
```

3. **Add module-level state and helpers** (near the top of the file, after imports):

```ts
let mainI18n: I18nInstance

async function bootI18n(): Promise<I18nInstance> {
  let initialLocale: Locale = FALLBACK_LOCALE
  try {
    // Replace `getGeneralSettings` with your actual settings-store API name
    const settings = await getGeneralSettings()
    const parsed = LocaleSchema.safeParse(settings.language)
    if (parsed.success) initialLocale = parsed.data
  } catch {
    // First launch or corrupt settings: fall back to 'en'
  }
  return createMainI18n({ locale: initialLocale })
}

function rebuildMenu(_locale: Locale): void {
  Menu.setApplicationMenu(buildAppMenu(mainI18n))
}
```

4. **Update the `app.whenReady()` block.** The existing code has a sequence; insert the i18n boot before the menu and handler registration. The shape becomes:

```ts
app.whenReady().then(async () => {
  // ...existing pre-i18n setup if any...

  mainI18n = await bootI18n()
  Menu.setApplicationMenu(buildAppMenu(mainI18n))

  registerAllHandlers({ i18n: mainI18n, rebuildMenu })

  // ...rest of existing boot (createWindow, etc.) follows unchanged...
})
```

**Critical invariants:**

- `bootI18n()` runs **before** `Menu.setApplicationMenu`
- `bootI18n()` runs **before** `registerAllHandlers`
- `mainI18n` is captured at module scope so `rebuildMenu` can read it without parameters

If `registerAllHandlers` is called somewhere other than `whenReady` callback, find it and update the signature there.

5. **Verify the app still boots** (it might still show English-everywhere because Task 16 hasn't migrated the menu yet):

```bash
pnpm dev
```

Expected: app launches as before. The native menu still shows English labels (Task 16 will localize them).

6. Stop dev mode (Ctrl+C).

7. **Run desktop typecheck**:

```bash
pnpm typecheck:desktop
```

Expected: passes. If it fails because `buildAppMenu` doesn't exist yet, **create a stub** for now in `apps/desktop/src/main/menu.ts`:

```ts
import { Menu } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'

export function buildAppMenu(_i18n: I18nInstance): Menu {
  return Menu.buildFromTemplate([])
}
```

Task 16 replaces the body with the real menu template. Mark this stub clearly with a comment so Task 16's executor knows to overwrite it.

8. **Commit**:

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/menu.ts
git commit -m "feat(i18n): boot main-process i18n before menu and handlers"
```

## Exit criteria

- [ ] `bootI18n()` runs in `app.whenReady` before menu/handlers
- [ ] `mainI18n` captured at module scope
- [ ] `rebuildMenu` callback uses `buildAppMenu(mainI18n)`
- [ ] `registerAllHandlers({ i18n: mainI18n, rebuildMenu })` is the new call shape
- [ ] App still boots (`pnpm dev` succeeds)
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — confirm `pnpm dev` actually starts before claiming done

## Report back

```
✅ Task 15 complete.
Commit SHA: <abbrev>
Boot order: settings → bootI18n → setApplicationMenu → registerAllHandlers → createWindow
typecheck:desktop: passes
pnpm dev: app launches successfully
Next: Task 16 (localize native menu)
```
