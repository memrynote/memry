# Turbo Cache

Memry uses [Turborepo](https://turborepo.com/docs/crafting-your-repository/caching) to cache task outputs across the monorepo. This note covers what is cached, how to inspect it, and how to debug misses.

## Cached vs Not Cached

| Task        | Cached? | Outputs                             |
| ----------- | ------- | ----------------------------------- |
| `dev`       | No      | (long-running, persistent)          |
| `build`     | Yes     | `out/**`, `dist/**`, `.wrangler/**` |
| `typecheck` | Yes     | `**/*.tsbuildinfo`                  |
| `test`      | Yes     | none (exit code only)               |
| `lint`      | Yes     | none (exit code only)               |

Cache storage is local-only via `.turbo/` in the repo root. Remote caching is not configured.

## Scoped Invalidation via `inputs`

Each cacheable task in `turbo.json` declares an `inputs` allowlist so unrelated file changes (e.g. Markdown, images, migrations) don't bust the cache. If you add a new file extension the task needs to watch, extend the `inputs` array there.

- `typecheck`: `.ts`, `.tsx`, `tsconfig*.json`, `package.json`
- `test`: `.ts`, `.tsx`, `**/*.test.*`, `package.json`, `vitest.config.*`
- `lint`: `.ts`, `.tsx`, `.js`, `.jsx`, `eslint.config.*`, `.eslintrc*`, `package.json`
- `build`: default (all tracked source), since builds can pull in JSON, assets, etc.

## Inspecting Cache Behavior

```bash
turbo run build --summarize         # writes .turbo/runs/<hash>.json with hit/miss per task
turbo run build --dry=json          # preview what would run without executing
turbo run build --force             # bypass cache (useful when debugging a suspected bad hit)
```

The human-readable summary at the tail of a run shows `cache hit, replaying logs` or `cache miss, executing …` per task. A full no-op re-run reports `>>> FULL TURBO`.

## Typecheck Incremental Note

No package currently sets `incremental: true` in `tsconfig.json`, so `**/*.tsbuildinfo` is a forward-looking output — if a package opts in later the cache picks it up with no `turbo.json` edit.
