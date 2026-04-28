# Task 0a: Preflight — verify `Intl.Locale.textInfo` works in Electron 39

> **Plan:** Task 0a (Risk Register Validations)
> **Depends on:** Task 00 (worktree exists)
> **Dependents:** Task 5 (`localeDirection` helper relies on this API)

## Pre-flight check

```bash
pwd                                # should be ../memry-i18n-phase-a
git rev-parse --abbrev-ref HEAD    # should be feature/i18n-phase-a
git status                         # must be clean
```

## Your job

Verify that `Intl.Locale.textInfo.direction` returns the correct values in Electron 39's V8. The spec relies on this API for runtime locale-direction detection (no fallback table). If unavailable, escalate before proceeding — `localeDirection` must work.

This is a 5-minute confidence check. We'll add a temporary log, run the app, observe the output, then revert.

## Steps

1. Edit `apps/desktop/src/main/index.ts`. Right after the `if (process.type === 'browser') { log.initialize() }` block (around lines 51–53), insert:

```ts
console.log('[i18n preflight]', {
  ar: new Intl.Locale('ar').textInfo.direction,
  en: new Intl.Locale('en').textInfo.direction,
  he: new Intl.Locale('he').textInfo.direction
})
```

2. Run dev mode:

```bash
pnpm dev
```

3. In the **main-process logs** (the terminal where you ran `pnpm dev`, not the renderer DevTools), observe the output. Expected:

```
[i18n preflight] { ar: 'rtl', en: 'ltr', he: 'rtl' }
```

4. **Decision gate:**

   - **If output matches:** the API works. Proceed to step 5 (cleanup).
   - **If `direction` is `undefined`:** Electron 39's V8 doesn't expose `textInfo`. **Stop and report this finding** — the spec needs revision (we'd need a fallback locale-direction table). Do not proceed with the rest of Phase A until resolved.

5. Stop dev mode (Ctrl+C in the terminal).

6. Revert the temporary log:

```bash
git checkout -- apps/desktop/src/main/index.ts
```

7. Verify reversion:

```bash
git status                         # must be clean
```

## Exit criteria

- [ ] Confirmed `Intl.Locale('ar').textInfo.direction === 'rtl'`
- [ ] Confirmed `Intl.Locale('en').textInfo.direction === 'ltr'`
- [ ] Confirmed `Intl.Locale('he').textInfo.direction === 'rtl'`
- [ ] Temporary log reverted; `git status` is clean

## Skills to use

None — this is exploratory verification.

## Report back

```
✅ Task 0a complete.
Output observed: { ar: 'rtl', en: 'ltr', he: 'rtl' }
Working tree: clean
Next: Task 0b (preflight react-i18next)
```

Or if the API is missing:

```
🚨 Task 0a BLOCKED.
Intl.Locale.textInfo unavailable in Electron 39.
Output observed: <paste actual output>
Recommend: pause Phase A, revise spec to use a fallback direction table.
```
