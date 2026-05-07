# Task 16: Localize the native Electron menu via `t()`

> **Plan:** Task 16 (Make the Native Menu Use `t()`)
> **Depends on:** Task 15 (i18n boots before menu, `buildAppMenu` stub may exist)
> **Dependents:** Task 25 (E2E asserts menu rebuilds in Turkish)

## Pre-flight check

```bash
pwd                                                                       # ../memry-i18n-phase-a
git status                                                                # clean
grep -rn "buildFromTemplate\|setApplicationMenu" apps/desktop/src/main/  # find existing menu construction
ls apps/desktop/src/main/menu.ts                                          # exists (stub from Task 15)
```

## Your job

Replace user-visible menu labels with `t()` calls so the menu rebuilds in the active locale. Preserve every existing menu item, accelerator, and click handler — this task is **labels-only**, not a menu refactor.

## Steps

1. **Find the existing menu construction.** It's likely either:
   - Inline inside `apps/desktop/src/main/index.ts`
   - In a dedicated menu module (look for `menu.ts` or similar)

   If it's inline in `index.ts`, you'll extract it. If it's already a module, modify in place.

2. **Replace `apps/desktop/src/main/menu.ts`** (overwriting the Task-15 stub) with a localized template. The structure below covers File / Edit / View. **Adapt this to mirror whatever menu items Memry currently has**, just with labels wrapped in `t()`:

```ts
import { Menu, type MenuItemConstructorOptions, app } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'quit' as const }] }]
      : []),
    {
      label: t('file.label'),
      submenu: [
        {
          label: t('file.newNote'),
          accelerator: 'CmdOrCtrl+N'
          // preserve existing click handler if any
        },
        { type: 'separator' as const },
        { role: 'close' as const }
      ]
    },
    {
      label: t('edit.label'),
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const }
      ]
    },
    {
      label: t('view.label'),
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
```

**IMPORTANT:** if the existing menu has more items, MORE submenus, or custom click handlers — preserve all of them. Only change _labels_ (the strings users see) to `t('menu:...')` calls. Add the new keys to `packages/i18n/src/locales/{en,tr,ar}/menu.json` if they aren't already there from Task 08.

3. **If existing menu was inline in `index.ts`**: remove the inline construction (it's replaced by `buildAppMenu`). Verify `Menu.setApplicationMenu(buildAppMenu(mainI18n))` is the only place setting the menu.

4. **Verify menu shows English on launch**:

```bash
pnpm dev
```

Expected: menu shows "File" / "Edit" / "View" (English) — same as before this task. Stop dev (Ctrl+C).

5. **Commit**:

```bash
git add apps/desktop/src/main/menu.ts apps/desktop/src/main/index.ts
git commit -m "feat(i18n): localize native Electron menu via t()"
```

## Exit criteria

- [ ] All user-visible menu labels use `t('menu:...')`
- [ ] All existing menu items, accelerators, and click handlers preserved
- [ ] `pnpm dev` launches with English menu (no regression)
- [ ] Any new menu keys added to `packages/i18n/src/locales/en/menu.json` (and tr/ar)
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — confirm `pnpm dev` works and menu still shows correct labels

## Report back

```
✅ Task 16 complete.
Commit SHA: <abbrev>
Menu items localized: <list, e.g. "File, Edit, View, plus N existing custom items">
New menu keys added: <list or "none — Task 08 covered all">
pnpm dev: menu correctly shows English on default boot
Next: Task 17 (renderer i18n instance, TDD)
```
