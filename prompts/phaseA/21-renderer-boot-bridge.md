# Task 21: Wire renderer boot + preload IPC bridge

> **Plan:** Task 21 (Wire Renderer Boot + Preload Bridge)
> **Depends on:** Tasks 14 (handler), 15 (main boot), 17–20 (renderer factory + provider + hooks + doc-attrs)
> **Dependents:** Tasks 22, 23, 24 (CSS, picker, error translation), Task 25 (E2E)

## Pre-flight check

```bash
pwd                                                          # ../memry-i18n-phase-a
git status                                                   # clean
ls apps/desktop/src/preload/                                 # see preload structure
cat apps/desktop/src/preload/index.ts | head -50            # see contextBridge pattern
cat apps/desktop/src/renderer/src/main.tsx | head -40       # see current renderer boot
```

## Your job

1. Add the locale IPC bridge to the preload (`window.api.locale.{get, set, list}` and `window.api.onLocaleChanged`)
2. Update the preload type declaration so consumers see the new methods
3. Run `pnpm ipc:check` / `ipc:generate` if needed
4. Replace the renderer boot in `main.tsx` with an async boot that fetches locale → creates i18n → applies doc attrs → mounts `<App>` inside `<I18nProvider>`
5. Subscribe to `onLocaleChanged` to keep the renderer in sync with main

## Steps

1. **Add the bridge to preload** — edit `apps/desktop/src/preload/index.ts`. Inside the `api` object exposed via `contextBridge.exposeInMainWorld('api', api)` (or equivalent name), add:

```ts
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'

const localeApi: LocaleApi = {
  get: () => ipcRenderer.invoke(LocaleChannels.Get),
  set: (locale: Locale) => ipcRenderer.invoke(LocaleChannels.Set, locale),
  list: () => ipcRenderer.invoke(LocaleChannels.List)
}
```

Then add `locale: localeApi` and an `onLocaleChanged` subscriber to the exposed `api` object:

```ts
const api = {
  // ...existing api members preserved...
  locale: localeApi,
  onLocaleChanged: (callback: (locale: Locale) => void) => {
    const listener = (_event: unknown, locale: Locale) => callback(locale)
    ipcRenderer.on(LocaleChannels.Changed, listener)
    return () => ipcRenderer.removeListener(LocaleChannels.Changed, listener)
  }
}
```

2. **Update preload type declaration** — `apps/desktop/src/preload/index.d.ts`. In the `Api` interface (or wherever the renderer-visible API type is declared), add:

```ts
locale: LocaleApi
onLocaleChanged: (callback: (locale: Locale) => void) => () => void
```

Add the import at the top of the .d.ts file:

```ts
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'
```

3. **Run `ipc:check` / `ipc:generate`** — if Memry's IPC tooling auto-generates anything, regenerate:

```bash
pnpm ipc:check
```

If it complains, run:

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected eventually: passes.

4. **Update renderer boot** — open `apps/desktop/src/renderer/src/main.tsx`. Replace the existing render block with the async boot:

```tsx
import { createRoot } from 'react-dom/client'
import { createRendererI18n, I18nProvider, applyLocaleToDocument } from '@memry/i18n/renderer'
import App from './App'
import './assets/main.css' // adapt path if Memry's CSS entry is elsewhere

async function boot(): Promise<void> {
  const initialLocale = await window.api.locale.get()
  const i18n = await createRendererI18n({ locale: initialLocale })
  applyLocaleToDocument(initialLocale)

  // Subscribe to runtime locale changes broadcast from main
  window.api.onLocaleChanged(async (locale) => {
    await i18n.changeLanguage(locale)
    applyLocaleToDocument(locale)
  })

  const root = createRoot(document.getElementById('root')!)
  root.render(
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  )
}

void boot()
```

**If the existing `main.tsx` has additional providers wrapping `<App/>`** (theme provider, query client, etc.), preserve them. Wrap with `<I18nProvider>` as the outermost or innermost — order doesn't matter for correctness, but conventionally i18n is outer.

5. **Typecheck**:

```bash
pnpm typecheck:desktop
```

Expected: passes.

6. **Smoke-test the boot**:

```bash
pnpm dev
```

App should boot with no UI changes (no strings migrated yet). In DevTools console:

```js
document.documentElement.dir // should print "ltr"
document.documentElement.lang // should print "en"
window.api.locale.get() // should resolve to "en"
window.api.locale.list() // should resolve to ["en", "tr", "ar"]
```

Then test live switching:

```js
await window.api.locale.set('ar')
document.documentElement.dir // should print "rtl"
document.documentElement.lang // should print "ar"
```

Native menu should rebuild in Arabic. UI should mostly look the same (no strings migrated yet, but doc direction flipped).

Switch back:

```js
await window.api.locale.set('en')
```

Stop dev (Ctrl+C).

7. **Commit**:

```bash
git add apps/desktop/src/preload/ apps/desktop/src/renderer/src/main.tsx
git commit -m "feat(i18n): wire renderer i18n boot and preload bridge"
```

## Exit criteria

- [ ] Preload exposes `window.api.locale.{get, set, list}` and `window.api.onLocaleChanged`
- [ ] Preload `.d.ts` declares the new methods
- [ ] `pnpm ipc:check` passes
- [ ] `apps/desktop/src/renderer/src/main.tsx` boots async with i18n setup before render
- [ ] DevTools smoke test passes (`<html dir>` flips on `locale.set('ar')`)
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — run the DevTools smoke tests in step 6 before claiming done

## Report back

```
✅ Task 21 complete.
Commit SHA: <abbrev>
ipc:check: passes
Smoke test:
  - locale.get() → "en"
  - locale.list() → ["en", "tr", "ar"]
  - After set('ar'): html dir=rtl, lang=ar
  - Native menu rebuilt in Arabic
Next: Task 22 (mirror-rtl CSS)
```
