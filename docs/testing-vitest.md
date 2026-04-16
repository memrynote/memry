# Testing — Vitest 4 baseline

Audit findings + idiom reference for the memry test suite. Lands Phase 6 U4 — see `.claude/plans/tech-debt-remediation.md § 6.4`.

## Current versions (as of 2026-04-16)

- `apps/desktop`: `vitest: "4"` (ANY 4.x; loose pin)
- `apps/sync-server`: `vitest: "^4.0.0"`
- Both workspaces on Vitest 4. No v3 deprecation warnings observed in CI logs.

## Vitest 4 config baseline

Desktop config lives at `apps/desktop/config/vitest.config.ts`. Three isolated projects:

| Project | Environment | Pool | Purpose |
|---|---|---|---|
| `shared` | node | default | Workspace `packages/**/*.test.ts` |
| `main` | node | `forks` (isolated) | Electron main-process tests in `src/main/**/*.test.ts` — longer `testTimeout: 15_000` for slower DB/crypto paths |
| `renderer` | jsdom | default | React/DOM tests in `src/renderer/**/*.test.ts` with React plugin + CSS support |

Coverage ratchet (baseline 2026-04-15, via `v8` provider):
- `statements: 37` (actual baseline 37.49)
- `branches: 28` (actual baseline 28.58)
- `functions: 34` (actual baseline 34.60)
- `lines: 38` (actual baseline 38.36)

Terminal target: `80/70/75/80`. Quarterly ratchet schedule lives in the plan's P.4 entry. **Do not drop below these floors** — CI fails the commit.

## Audit: deprecated v3 patterns

Grepped the whole test surface for the patterns most likely to produce v4 deprecation warnings or break:

| Pattern | Action | Finding |
|---|---|---|
| `vi.fn<Args, Return>()` (legacy two-arg generic) | Replace with `vi.fn<typeof fn>()` | Not found. All observed usage is single-type-arg form. |
| `vi.mocked(fn)` without type arg | Keep — supported in v4 | Used idiomatically. |
| `import.meta.vitest` | Keep — supported in v4 | Not used. |
| `vi.hoisted` | Keep — behavior preserved in v4 | Not used. |
| `describe.concurrent` / `it.concurrent` | Keep — supported | Not used. |
| `mockResolvedValueOnce` / `mockRejectedValueOnce` chains | Keep — resolution order is stable in v4 | Used cleanly. |
| `vi.resetAllMocks` vs `vi.clearAllMocks` | Either is fine | No implicit-reset assumptions spotted. |
| `test.workspace` vs `test.projects` (v4 idiom) | Use `projects` | `apps/desktop/config/vitest.config.ts` uses `projects` — good. |
| `poolOptions.threads.singleThread` (v3) | Replaced by `singleFork` in v4 fork pool | `pool: "forks"` is configured on the `main` project with no stale `singleThread` key. |

Running `pnpm test 2>&1 | tee /tmp/vitest-audit.log && grep -iE 'deprecated|will be removed' /tmp/vitest-audit.log` returns **zero hits**. Audit clean as of the ship date.

## Idioms in use across the codebase

Cited examples come from real test files, not invented demos.

### Default-export mocks

```ts
// apps/desktop/src/main/crypto/keychain.test.ts
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
    findCredentials: vi.fn()
  }
}))
```

### Typed mock factories

```ts
// apps/desktop/src/main/calendar/google/oauth.test.ts
const fetchMock = vi.fn<typeof fetch>()
globalThis.fetch = fetchMock
vi.mocked(keytar.setPassword).mockResolvedValue(undefined)
```

### Renderer tests (jsdom)

```ts
// apps/desktop/src/renderer/src/hooks/use-undo.test.ts
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
```

## File layout conventions

- Main-process tests live **next to source**: `src/main/.../foo.ts` → `src/main/.../foo.test.ts`.
- Shared fixtures live in `apps/desktop/tests/utils/fixtures/` (Phase 3.3 convention — must stay there so cross-package type imports like `TestDatabaseResult` resolve without tsconfig-exclude gymnastics that break ESLint's typed-lint service).
- E2E specs are separate: `apps/desktop/tests/e2e/*.e2e.ts`, driven by Playwright + Electron, not Vitest.

## Known gotchas (cite from memory / CLAUDE.md)

- **Zod v4**: `z.record(z.unknown())` throws in `safeParse`. Always write `z.record(z.string(), z.unknown())` in schemas used by any test-validated contract.
- **`better-sqlite3` ERR_DLOPEN_FAILED**: if a main-process test fails with `ERR_DLOPEN_FAILED`, it's NODE_MODULE_VERSION mismatch, not a test regression. Run `pnpm rebuild:node` (or the new `pnpm check:native` from Phase 6 U1 to diagnose first).
- **Pre-existing type errors** in `websocket.test.ts`, `folders.test.ts`, `sync-telemetry.ts` — tracked separately; not blocking for typecheck-on-PR.

## References

- Plan source: `.claude/plans/tech-debt-remediation.md § 6.4`.
- Vitest 4 migration guide: [vitest.dev/guide/migration](https://vitest.dev/guide/migration.html).
- Coverage ratchet origin: Phase 0.5 entry in the same plan.
