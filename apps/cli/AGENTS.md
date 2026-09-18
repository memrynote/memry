# CLI Rules

Command-line vault access (`@memry/cli`). Root `AGENTS.md` applies; this file adds CLI rules.

## Layout

- `bin/` — executable entry.
- `src/run.ts` — command dispatch.
- `src/app-core/` — the vault operations: notes, folders, inbox, tasks, templates, sync, versions, bookmarks, reminders, properties.

`src/app-core` is the CLI's mirror of desktop behavior. When a desktop feature changes shape, this is where the CLI drifts. `scope-parity.test.ts` exists to catch that drift — read it before adding a command.

## Commands

```bash
pnpm --filter @memry/cli typecheck
pnpm --filter @memry/cli test
```

Tests live next to the code (`*.test.ts`). If you create or modify one, run it and iterate until it passes.

## Behavior

- The CLI writes to a real user vault. Every destructive operation needs an explicit flag or confirmation; never destructive by default.
- Non-zero exit code on failure. A command that fails silently is worse than one that crashes.
- Errors go to stderr, results to stdout. Anything that might be piped stays machine-readable.
- No interactive prompt in a code path that can run non-interactively. Check for a TTY before prompting.
- Respect the vault path and locale resolution already in `paths.ts` and `locale.ts`. Do not re-derive paths inline.

## Compatibility

- The CLI reads vault files and databases written by desktop versions the user may not have updated. Tolerate older formats; never migrate a vault as a side effect of a read command.
- Command names, flags, and output shape are a contract once shipped. Adding is fine; renaming or removing is not, unless the user asks.
