# Task 24: Extend `extractErrorMessage` to resolve i18n keys

> **Plan:** Task 24 (Add `extractErrorMessage` Pass-Through for Translation Keys)
> **Depends on:** Task 21 (renderer i18n initialized)
> **Dependents:** Phase B onward (errors raised with `errors:*` keys translate automatically)

## Pre-flight check

```bash
pwd                                                                       # ../memry-i18n-phase-a
git status                                                                # clean
cat apps/desktop/src/renderer/src/lib/ipc-error.ts                       # see existing impl
```

## Your job

Extend `extractErrorMessage(err, fallback)` to resolve i18n keys: if the extracted error message starts with `errors:`, attempt translation via `i18next.t(message)`. If translation succeeds (returns something different from the input key), use it; otherwise fall back to the raw message.

This is a Phase A *enabler*. No errors actually use this path yet — Phase B–E migrations can start emitting `errors:sync.network-failed` style messages and have them auto-translate.

## Steps

1. **Read existing implementation** to understand the structure:

```bash
cat apps/desktop/src/renderer/src/lib/ipc-error.ts
```

2. **Edit `apps/desktop/src/renderer/src/lib/ipc-error.ts`**. After the existing logic that extracts the raw message (call it `raw`), add a translation pass:

```ts
import i18next from 'i18next'

const I18N_KEY_PREFIX = 'errors:'

export function extractErrorMessage(err: unknown, fallback: string): string {
  // ...existing extraction logic produces `raw` string...

  if (raw.startsWith(I18N_KEY_PREFIX)) {
    const translated = i18next.t(raw)
    if (translated !== raw) return translated
  }

  return raw || fallback
}
```

The exact insertion point depends on the existing function structure. Pattern: after the raw extraction, before returning, attempt translation if the string looks like an i18n key. Errors that don't use the prefix flow through unchanged.

**Preserve all existing behavior** — this is additive. Strip-IPC-noise logic, fallback logic, etc., must all remain.

3. **Run desktop tests**:

```bash
pnpm --filter @memry/desktop test ipc-error
```

Expected: existing tests pass (we changed nothing about the non-i18n-key path).

4. **Add a small test** to confirm the i18n path is opt-in (doesn't activate for plain errors). Append to whichever test file covers `ipc-error`:

```ts
it('passes through plain error messages unchanged', () => {
  const result = extractErrorMessage(new Error('plain error'), 'fallback')
  expect(result).toBe('plain error')
})
```

(A full test of the i18n path requires setting up a test i18n instance — defer to Phase B when an actual translated error key exists.)

5. **Re-run tests**:

```bash
pnpm --filter @memry/desktop test ipc-error
```

Expected: passes.

6. **Commit**:

```bash
git add apps/desktop/src/renderer/src/lib/ipc-error.ts
# include the test file if it lives elsewhere
git commit -m "feat(i18n): allow extractErrorMessage to resolve i18n keys"
```

## Exit criteria

- [ ] `extractErrorMessage` translates `errors:*`-prefixed messages via `i18next.t`
- [ ] Plain (non-prefixed) error messages flow through unchanged
- [ ] Existing tests pass
- [ ] At least one test verifies pass-through behavior unchanged
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — confirm tests pass before claiming done

## Report back

```
✅ Task 24 complete.
Commit SHA: <abbrev>
Tests: <N> pass
Next: Task 25 (E2E Playwright spec)
```
