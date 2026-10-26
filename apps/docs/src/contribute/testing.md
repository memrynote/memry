# Testing

Vitest for unit and integration tests, Playwright for E2E (Electron). Tests run via Turborepo so you can scope by package.

## Quick Reference

```bash
pnpm test                              # all packages
pnpm --filter @memry/desktop test      # desktop only
pnpm --filter @memry/sync-server test  # sync server only
pnpm --filter @memry/desktop test:coverage
pnpm --filter @memry/sync-server exec vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text-summary
pnpm i18n:check                        # hardcoded text + locale resource coverage
pnpm test:i18n-tools                   # i18n scanner/check tool tests
pnpm test:e2e                          # Playwright
node apps/desktop/scripts/build-packaged-app.js --dir
node apps/desktop/scripts/check-packaged-runtime-deps.js
```

## Unit + Integration (Vitest)

Run from the repo root or scope with `--filter`:

```bash
pnpm --filter @memry/desktop test
pnpm --filter @memry/desktop test path/to/file.test.ts
pnpm --filter @memry/desktop test -- --watch
```

Test files live next to the code they cover (`foo.ts` + `foo.test.ts`).

### Seed Vault Fixtures

Desktop seed-vault data lives under `apps/desktop/scripts/seed-data/` and is covered by
the desktop main Vitest project. Keep demo dates relative through the shared seed date helper so
the generated vault stays current on the day a developer runs it. The seed set should read like a
real personal vault: linked notes, inbox captures, calendar items, and tasks should point at each
other instead of standing alone.

No literal dates. `seedJournalDate` in `scripts/seed-data/date.ts` shifts a narrative date by the
offset between `JOURNAL_ANCHOR` and the run day, so entries and date properties dated before the
anchor land in the past and the ones after it land in the future. It covers journal filenames, the
`startDate` / `endDate` / `deadline` note properties, dated rows inside note bodies, and any
`[[YYYY-MM-DD]]` wikilink pointing at a journal entry — a hardcoded date there dangles the moment
the timeline moves.

The project hub is seeded too: `project_links` rows point each project at its notes and calendar
events (`scripts/seed-data/project-links.ts`), and `projects.home_note_id` supplies the overview
note. Those links carry no foreign key to their target, so they are inserted after the notes and
events they reference. File links are intentionally absent — binary files get their id from the
indexer at vault-open time, so a pre-seeded file id would never match.

For notes, those rows are only a head start. A markdown note's project membership lives in its
`project:` frontmatter, and the note-project-links projector rebuilds `project_links` from it on
every `note.upserted` — a seeded row with no matching frontmatter key is deleted the first time
that note is indexed. `NOTE_PROJECTS` in `scripts/seed-data/notes.ts` is what actually makes the
membership stick; `project-links.test.ts` fails if a seeded note link has no frontmatter behind it.

Property definitions work the same way. `.memry/properties.md` is the source of truth: the service
reloads it on vault open and rebuilds the `property_definitions` table from it, so definitions
written only to the table are wiped before anyone sees them. The seed writes that file from
`scripts/seed-data/properties.ts`, which is also where the `status` categories and the select and
multiselect option lists live. Only the five persistable kinds may appear in the file — `status`,
`select`, `multiselect`, `date`, `project` — because one unparsable entry fails the schema and
discards every definition in it; text, number, URL and checkbox properties are typed by inference
from their values instead.

The seed includes canvases, written as plain `.excalidraw` files under `canvases/` through the
app's own writer (`main/canvas/scene-file.ts`), so the seed can never drift from the real format.
No keychain, no key material, no device binding: a seeded vault opens in any dev profile and keeps
working after it is copied elsewhere. `--device` is accepted and ignored — it used to pick the
keychain entry the canvas ciphertext was bound to.

The seed no longer writes the vault key-verifier setting. It used to, which silently rebound the
vault to a key it had just minted — the failure mode that made an already-open vault report
"Current master key does not match this vault".

When changing seed data, run the relevant seed-data test file or the desktop main test project:

```bash
pnpm --filter @memry/desktop test:main -- scripts/seed-data
pnpm --filter @memry/desktop seed:vault
```

### Benchmark Vault

The demo seed stays small so it reads well in screenshots, which leaves nothing to measure
indexing, search, the graph, or the notes list against. `pnpm seed1k` fills a separate vault with
1000 fully-written notes — frontmatter, headings, bullet lists, a table, checkboxes, code blocks,
and wiki-links, roughly 2 KB of markdown each — spread evenly across ten folders.

```bash
pnpm seed1k                                  # ~/MemryBenchVault, 1000 notes, seed 42
pnpm seed1k -- --count=5000                  # a larger corpus
pnpm seed1k -- --vault=/tmp/bench --seed=7   # a second vault to compare against
```

Content comes from a seeded PRNG (`scripts/seed-data/bulk-notes.ts`), so the same `--seed` and
`--count` produce a byte-identical vault and two benchmark runs compare like for like. The command
always wipes its target first, and writes `note_metadata` rows alongside the files so note ids stay
stable when the indexer adopts them by path.

### Key Rules

- Real SQLite (not mocked) for database tests — uses an in-memory DB per test.
- Real crypto (libsodium) — fast enough that mocking isn't worth the divergence risk.
- IPC handlers are tested by importing them directly; no Electron runtime needed.
- Time-sensitive workflow tests should use dates relative to the current run instead of fixed
  calendar dates, so snooze/reminder assertions do not expire as CI time moves forward.

## E2E (Playwright)

```bash
pnpm test:e2e
pnpm test:e2e --headed                  # see the window
pnpm test:e2e --ui                      # interactive runner
pnpm test:e2e -- tests/notes.spec.ts    # one file
```

> E2E runs against the **built bundle** (`out/main/index.js`), not source. After editing source, rebuild:
>
> ```bash
> npx electron-vite build
> pnpm test:e2e
> ```
>
> Skipping the rebuild is the #1 source of "passes locally, fails in CI" surprises.

Main-push Desktop CI runs the full Electron E2E suite across 8 Playwright shards, each running 2
workers — the same 16 parallel lanes the old 16-shard matrix had, but the per-job install and build
is paid half as often. Those shards do not build the app themselves: a single `Desktop build (Linux)`
job builds `out/` plus the Electron-ABI native modules once and ships them as an artifact that every
Linux E2E job restores. Local E2E keeps the default 60s test timeout and 20s assertion timeout, while
CI raises those to 180s and 60s, with helper-specific headroom for sync replication and Agent/MCP
startup on slower Linux runners.

Two workers means two Electron apps at once, so anything an E2E launch touches must be per-launch:
each launch gets its own `mkdtemp` user-data dir, its own `e2e-<uuid>` device id (which namespaces
every keychain account), and every server the harness starts binds an ephemeral port — the simulated
sync server included, since miniflare's default 8787 would otherwise collide between workers.

### E2E Keychain Cleanup (macOS)

Sync E2E launches set `MEMRY_DEVICE=e2e-<uuid>-A|B`, and every keychain account is suffixed with
that device id. The OS keychain is machine-global and outlives the throwaway user-data dir, so each
launch mints permanent `com.memry.sync` items. Teardown now deletes them:
`tests/e2e/utils/keychain-cleanup.ts` purges the run's accounts, and fixtures call
`destroyLaunchedElectron(launched)` — prefer it over `destroyElectronApp`, since it derives the dirs
and device id from the launch so a new fixture cannot forget the purge. The purge only ever fires
for device ids matching `/^e2e-[A-Za-z0-9-]+$/`, so local `A`/`B`/`C`/`dev` vaults and production's
bare `master-key` are never touched. macOS only — keytar is built for the Electron ABI here, so
teardown shells out to `security(1)` instead.

To reclaim a backlog from runs that predate this cleanup:

```bash
pnpm --filter @memry/desktop keychain:purge-e2e            # dry run, prints counts
pnpm --filter @memry/desktop keychain:purge-e2e -- --apply # delete
```

### E2E Test Hooks

Desktop E2E helpers live behind `globalThis.__memryTestHooks` and only register when
`NODE_ENV=test`. Keep hooks deterministic and limited to test control surfaces such as seeded
sync data, secondary windows, or Quick Capture shortcut probes. If a flow can be tested through
normal user-visible UI, prefer that path before adding a hook.

Sync E2E bootstrap opens local vault state before attaching shared sync credentials. Keep
`bootstrapSyncDevice` responsible for rebinding the test vault key and starting the sync runtime
before sync assertions run; otherwise queued records can fail before they reach the test backend.
Account-sync E2E should wait until both bootstrapped devices see the complete device list before
revoking a remote device. Removing another device must not emit the current-device revoked event
back into the renderer that initiated the removal.
Split-view E2E locators depend on the pane root exposing `data-testid="tab-pane"`, so keep that
test id stable when changing pane/drop-zone markup.

Agent Chat approval cards render inline in the chat stream, not as modal dialogs. Scope approval
selectors to the Agent chat region, and scope post-approval assertions to the destination surface
instead of broad text that can still appear in the chat transcript or tool arguments.
Vault unit tests import the vault index with narrow Electron mocks. Keep Agent runtime startup behind
vault open/close service functions so note and database tests do not need to load Agent IPC handlers.

### Agent Live-App Sandbox

`apps/desktop/scripts/agent-app.mjs` lets a coding agent drive the built app the way a person
would, without writing a Playwright spec first. It is for exploring, debugging and verifying a
change; E2E specs stay the regression gate.

```bash
pnpm --filter @memry/desktop exec electron-vite build   # after code changes
node apps/desktop/scripts/agent-app.mjs start             # CDP :9222, inspector :9229
node apps/desktop/scripts/agent-app.mjs eval "__memryDebug.query('SELECT title FROM tasks')"
node apps/desktop/scripts/agent-app.mjs stop
```

`start` uses the same isolation as E2E fixtures: a copy of the E2E test vault, a temp user-data
dir, `NODE_ENV=test`, and an `e2e-agent-<uuid>` device, so real profiles, vaults and keychain
accounts are never opened. `stop` removes the temp dirs and the run's keychain items. It refuses
to start when native modules are built for Node instead of Electron.

Two optional variables change what `start` opens:

- `MEMRY_AGENT_VAULT_TEMPLATE=<dir>` opens a copy of that vault instead of the E2E test vault.
  The copy keeps the folder's name, which the sidebar shows. The template itself is never opened.
- `MEMRY_AGENT_SCALE=2` renders at a forced 2x device scale, so screenshots and screencasts stay
  sharp on a 1x display. Tutorial recordings under `marketing/tutorials/` use both.

The renderer is driven by the official Playwright MCP (`playwright-memry` in `.pi/mcp.json`,
connected with `--cdp-endpoint`). The main process is read with `eval`, which runs an expression
over the Node inspector. Under `NODE_ENV=test`, `globalThis.__memryDebug` exposes read-only SQL on
`data.db` (`query`) and `index.db` (`indexQuery`), plus `syncEngine()`, `crdt()` and `store`.
SQL is read-only because a raw write skips vector clocks, sync enqueueing and renderer
broadcasts; seed through the UI or `__memryTestHooks` instead. Single instance only, so flows that
need two synced devices still belong in E2E.

### Agent sandbox on Tauri

`apps/desktop-tauri/scripts/agent-app.mjs` is the Tauri counterpart of the Electron sandbox above. It starts the e2e build in a throwaway sandbox so an agent can drive it over WebDriver.

```bash
pnpm --filter @memry/desktop-tauri build:e2e                 # after code changes
node apps/desktop-tauri/scripts/agent-app.mjs start          # WebDriver on 127.0.0.1:9222
node apps/desktop-tauri/scripts/agent-app.mjs eval "document.title"
node apps/desktop-tauri/scripts/agent-app.mjs shot /tmp/agent.png
node apps/desktop-tauri/scripts/agent-app.mjs status
node apps/desktop-tauri/scripts/agent-app.mjs stop
```

`start` writes a control file for its port (a temp app data dir, the log directory, an `e2e-agent-<uuid>` device and a copy of the test vault), starts the binary with `MEMRY_E2E=1` and `TAURI_WEBDRIVER_PORT`, and waits until the app answers `e2e_app_info`. `stop` asks the app to quit, removes the temp dirs and the control file, and purges the keychain items of the device. Only one instance runs at a time. State lives in `$TMPDIR/memry-agent-app-tauri.json`, so the Electron and Tauri sandboxes can be inspected side by side (they still cannot run together on one port).

Options:

- `MEMRY_AGENT_VAULT_TEMPLATE=<dir>` opens a copy of that vault. `MEMRY_AGENT_FIRST_RUN=1` opens no vault, so the first-run setup shows.
- `MEMRY_AGENT_SCALE=2` renders at 2x on Windows (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) and Linux (`GDK_SCALE`); macOS renders at the display scale and ignores it.
- `MEMRY_AGENT_BINARY=<path>` replaces `crates/target/debug/memry-tauri`. `TAURI_WEBDRIVER_PORT=<port>` replaces 9222.

`eval` runs in the renderer; the main process has no eval. The webview is driven by the `webdriver-memry` MCP server (`apps/desktop-tauri/scripts/webdriver-mcp.mjs`, `.pi/mcp.json`), which keeps the tool names of the Playwright MCP (`browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`, ...). `pnpm staging:tauri` runs the app against staging, and `pnpm staging:tauri:debug` adds the e2e build with WebDriver on port 9333 and a persistent profile in `~/.memry/staging-tauri-profile`; it reads `apps/desktop-tauri/.env.staging`, which is gitignored.

For a Windows or Linux VM, CI builds the app on demand: `gh workflow run desktop-tauri-ci.yml --ref <ref>` uploads `memry-tauri-e2e-<os>-<arch>` (the Ubuntu VM is arm64, so `linux-arm64`), which the `vm-repro` skill installs.

### Virtualized UI Tests

`@tanstack/react-virtual` doesn't render any items inside jsdom (heights are zero, virtualization sees no scrollable area). Cover virtualized calendar / week / list UIs at the **Playwright** layer only.

## E2E on Tauri

The Tauri desktop app (`apps/desktop-tauri`) has its own end-to-end suite on WebdriverIO. The Playwright sections above keep covering the Electron app until the cutover step deletes it. A new e2e test for the Tauri app goes in `apps/desktop-tauri/e2e/specs`.

```bash
pnpm --filter @memry/desktop-tauri build:e2e        # the e2e build (cargo feature `e2e`)
pnpm --filter @memry/desktop-tauri test:e2e         # shell specs, up to two apps in parallel
pnpm --filter @memry/desktop-tauri test:e2e:multi   # two-device specs, instances A and B
pnpm --filter @memry/desktop-tauri test:e2e:harness # unit tests of the harness
pnpm --filter @memry/desktop-tauri check:test-hooks # every Electron test hook is mapped
```

`MEMRY_E2E_BINARY` points the harness at another binary; the default is `crates/target/debug/memry-tauri`. `--spec e2e/specs/shell/startup.e2e.ts` runs one spec. A JUnit file per worker lands in `apps/desktop-tauri/test-results/e2e`.

### How a test reaches the app

The app embeds a W3C WebDriver server, but only in a build made with the `e2e` cargo feature, and only when it starts with `MEMRY_E2E=1`. A release build carries neither. CI proves it: `no-driver-smoke` starts a build without the feature with `MEMRY_E2E=1`, then checks that no port listens, that `main.log` names no driver and that the binary holds no `e2e_` command.

The harness starts one app per test, on a free port, with its own data directory, log directory, webview profile and device id (`e2e-<uuid>`). It writes these to a control file, `<temp dir>/memry-e2e/control-<port>.json`, and the app reads the file named by its own `TAURI_WEBDRIVER_PORT` before it computes any path. `fresh` throws `control file not applied` when the app reports other directories than the file named. `restart(app)` closes the app gracefully and starts it again on the same files; the pid changes and the data stays.

The main process has no eval. A spec calls a named command: `invokeTest(app, 'e2e_...', args)`. Every command starts with `e2e_`, answers `e2e_disabled` while the gate is closed, and is listed in `apps/desktop-tauri/e2e/HOOKS.md` next to the Electron hook it replaces.

Two instances at once need macOS 14 or later, because each instance needs its own webview data store.

### Porting a Playwright spec

`import { test, expect } from '../../harness/test'` gives `test` with the fixtures `app`, `page`, `testVaultPath`, `deviceId`, `appB`, `pageB` and `vaultPathB`. `page`, `locator` and `expect` follow the Playwright API that the specs use (`getByRole`, `getByTestId`, `filter`, `nth`, `fill`, `press`, `toBeVisible`, `poll`, ...), so most specs port by changing the import and replacing each `electronApp.evaluate` with an `invokeTest` call. `HOOKS.md` holds the full mapping table.

Limits of the adapter: the macOS WebView driver sends synthetic mouse events, so `pw-compat` adds the pointer events, focus change, `dblclick` and `contextmenu` a real click produces; drag and drop and text selection by mouse need a driver with native input. Native dialogs, the color picker and native menus cannot be clicked, so a spec never opens one; `HOOKS.md` describes the dialog result queue that Step 08 (#3525) builds.

### Running the harness on a Windows or Linux VM

Install Node 24 and `npm install` the `devDependencies` of `apps/desktop-tauri/package.json` that start with `@wdio` or `webdriverio`, plus `tsx`, next to a copy of `apps/desktop-tauri/e2e`, set `MEMRY_E2E_BINARY` to the e2e build from CI, and run `wdio run e2e/wdio.conf.ts`. Checked on 2026-10-24:

- Windows 11 ARM64 (VMware Fusion, WebView2 154): start the run from a scheduled task with `/it` so it has the console session. Every spec passes. WebView2 helper processes keep the profile open for a moment after the app exits, so the harness retries removing a profile directory for 10 seconds.
- Ubuntu 24.04 ARM64 (tart, x64 build under Rosetta, XFCE): install `libwebkit2gtk-4.1-0`, `libsoup-3.0-0`, `libayatana-appindicator3-1` and `libxdo3` for `amd64`. No `WEBKIT_*` variable is needed. Startup, restart, window and two-device pass. The 300 ms `click` budget in `pw-compat` fails there (about 470 ms) because the VM runs the build under Rosetta without a GPU; native CI runners decide that budget.
- A window larger than the display is maximized by the window manager and ignores `set_size`, so `e2e_set_window_rect` restores the window first and CI starts Xvfb with a 1920x1080 screen.

### Keychain

Specs that sign in leave keychain items under `e2e-` device ids. The harness removes them when the run ends. `node apps/desktop-tauri/e2e/scripts/purge-e2e-keychain.mjs` lists leaked items and deletes nothing; `--apply` deletes only accounts that match `e2e-`.

## IPC Contract Check

```bash
pnpm ipc:check       # validate renderer/main contracts typecheck
pnpm ipc:generate    # regenerate the typed invoke map
```

When to run:

- Any time you touch a Zod schema in `packages/contracts`
- Any time you add or rename an IPC channel
- Before opening a PR that touches the boundary

## Markdown Converter Vectors

The Rust markdown converter in `crates/memry-core` is checked against vectors produced by the Electron converter. Regenerate them after a change to that converter, to the packages it uses, or to the case list in `apps/desktop/scripts/markdown-oracle/`:

```bash
pnpm --filter @memry/desktop vectors:markdown-convert          # run the oracle, rewrite the class
pnpm --filter @memry/desktop vectors:markdown-convert:check    # regenerate to a temp dir, diff, write nothing (CI)
pnpm --filter @memry/contracts test                            # verifier: case counts, coverage list, file digests
cd crates && cargo test -p memry-core --features markdown      # the Rust side
```

The same oracle backs three ignored Rust runs that prove the converter beyond the committed vectors. `cargo test -p memry-core --features markdown --release --test markdown_differential -- --ignored --nocapture` mutates inputs and compares the two converters (20000 per run; `MEMRY_DIFF_INPUTS`, `MEMRY_DIFF_SEED` tune it). `markdown_corpus` compares whole vaults (the synthetic one comes from `MEMRY_CORPUS_SYNTHETIC`, the sandbox one from `pnpm --filter @memry/cli sandbox --vault=<new empty dir>`): run the oracle with `MEMRY_CORPUS_OUT=<file> MEMRY_CORPUS_DIRS=<dir:dir> [MEMRY_CORPUS_SYNTHETIC=<empty dir>]` under `--project markdown-oracle`, then the Rust test with `MEMRY_CORPUS_JSONL=<file> MEMRY_CORPUS_DIRS=<same dirs>`. `markdown_perf_budget` prints timings for a release build. The nightly `markdown-fuzz` workflow runs the differential, the synthetic vault and the two cargo-fuzz targets.

After regenerating, update the digests in `packages/contracts/src/__tests__/markdown-convert.test.ts` and the table in `packages/contracts/test-vectors/README.md`. The oracle runs in the `markdown-oracle` Vitest project with the time zone set to UTC.

## I18n Checks

```bash
pnpm i18n:check
pnpm test:i18n-tools
```

The i18n check scans desktop source for untranslated UI text, verifies every referenced key exists
in the English bundles, and keeps non-English locale files aligned with English resources. Run the
tool tests when changing `apps/desktop/scripts/i18n/*` so scanner allowlists, JSON output, TODO
limits, and locale-completeness behavior stay covered.

Alongside it, the `i18n/no-toast-string-literal` oxlint rule guards toast copy in the renderer. It
judges the static text of the first argument, so interpolation is no exemption — a hard-coded
English template such as ``toast.error(`Could not open ${name}`)`` is reported exactly like
`toast.error('Could not open file')`. Pass the values as placeholders instead:

```ts
toast.error(t('notes:page.toast.fileNotFound', { target }))
```

A template whose letters all come out of `t()` — ``toast.error(`${t('a')}: ${t('b')}`)`` — stays
valid, because only punctuation and spacing are hard-coded. `TODO(i18n): wrap … in t()` silences the
rule for one call site, but `pnpm i18n:check` runs with `--max-todo 0`, so it is a review aid rather
than a way to land untranslated copy.

## Lint and format

The repo lints with oxlint and formats with oxfmt. One config, `oxlint.config.mts`, covers every
JS/TS file, tests included, with type-aware rules (TypeScript 7 through `oxlint-tsgolint`).

```bash
pnpm lint            # oxlint over the whole repo, through the lint ratchet
pnpm lint --update   # lower scripts/lint-baseline.json after fixing violations
pnpm format          # oxfmt, write
pnpm format:check    # oxfmt, check only (CI runs this)
```

Many rules still have old violations. Each rule with a backlog runs as a warning, and
`scripts/lint-ratchet.mjs` holds it at the per-file counts in `scripts/lint-baseline.json`. For
example, if `src/a.ts` has 3 `typescript/no-floating-promises` warnings in the baseline, a fourth
fails `pnpm lint` and the output lists every occurrence in that file. Fixing one and running
`pnpm lint --update` lowers the count to 2. When a rule's last violation is gone it drops out of
the baseline and becomes an error, with no config change.

Pre-commit runs oxfmt and oxlint on staged files, errors only, without type information and
without `--fix`: some oxlint fixers change types or behavior (`promise-function-async` adds
`async`), so fixes stay an explicit `pnpm lint:fix` followed by `pnpm typecheck`.

## Focused Typecheck

Skip the flaky pre-hooks and known pre-existing errors:

```bash
pnpm typecheck:node     # main process only
pnpm typecheck:web      # renderer only
```

### Typechecking test files

The two configs above compile app source only — they exclude `**/*.test.ts(x)` and `**/*.spec.ts`.
Test files are compiled by three more projects:

```bash
pnpm --filter @memry/desktop typecheck:test        # all three
pnpm --filter @memry/desktop typecheck:test:node   # tests/** harness + main/preload tests
pnpm --filter @memry/desktop typecheck:test:web    # renderer tests
pnpm --filter @memry/desktop typecheck:test:e2e    # Playwright specs, utils and fixtures in tests/e2e
```

`tsconfig.test.e2e.json` adds the DOM lib so `page.evaluate` callbacks type against the renderer's
globals. It has no backlog: a spec must compile, and code that is dynamic by nature gets a narrow
local type, never `@ts-nocheck`. Playwright runs specs without type information, so a removed
binding or a value import turned type-only passes lint and only fails at run time. This gate is what
catches it before the e2e job does.

`pnpm typecheck` runs all five, and CI has a step per project. Each one runs `scripts/typecheck.mjs`,
which hands exactly the files a tsconfig includes to `oxlint --type-check` (TypeScript 7).

`apps/desktop/tsconfig.test.node.json` and `apps/desktop/tsconfig.test.web.json` each carry an
`exclude` array listing test files that already failed to compile when the gate was introduced.
That list is a shrinking backlog, not a policy: a new or newly-touched test file must compile, so
never add an entry. Fixing a listed file's errors means deleting its line as well.

This is what makes type-level guards in test code real. `implements`, `satisfies`, and typed harness
signatures used to be checked only by your editor — a mock that drifted from the class it stands in
for would silently answer `undefined` at runtime instead of failing the build.

## Native Module Rebuild

`better-sqlite3` and `keytar` are the most common source of native runtime failures. If you see `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION` mismatches, or a Mach-O architecture error:

| Target             | Fix                                                   |
| ------------------ | ----------------------------------------------------- |
| Node tests         | `pnpm rebuild better-sqlite3`                         |
| Electron app / E2E | `bash apps/desktop/scripts/ensure-native.sh electron` |

Using the Node fix for Electron (or vice versa) leaves the app silently broken — see [Common Gotchas](/contribute/gotchas).

## Packaged Runtime Smoke

The packaged smoke check builds the app into `apps/desktop/dist/mac-arm64/MemryNote.app` from an
isolated dependency tree, then verifies runtime dependencies resolve from the packaged Resources
directory. It also checks native `.node` binaries for the expected macOS architecture so an arm64
release cannot ship with x64 `better-sqlite3` or `keytar` binaries:

```bash
node apps/desktop/scripts/build-packaged-app.js --dir
node apps/desktop/scripts/check-packaged-runtime-deps.js
```

The packaged runtime check runs its native-module probe through the built
`MemryNote.app/Contents/MacOS/MemryNote` executable, so it verifies the same Electron runtime that
will ship instead of depending on the workspace `electron` package binary.
The desktop unit coverage job sets `ELECTRON_OVERRIDE_DIST_PATH=/usr/bin` before Vitest so
main-process tests can import `electron` for IPC and `BrowserWindow` mocks even when the workspace
Electron binary download is unavailable on the runner.
Main-push E2E jobs still need the workspace `electron` package binary; `ensure-native.sh electron`
clears fallback install env and verifies `path.txt` before Playwright launches Electron.
That path uses a blocking installer helper pinned to Electron's official release mirror, checks the
downloaded archive against Electron's packaged checksum, then verifies the extracted binary before
native rebuild starts. `ensure-native.sh` trusts that helper-level check instead of rerunning the
package installer's `path.txt` probe. CI also reruns the helper at the start of each E2E step, after
`electron-vite build`, so Playwright sees a fresh workspace Electron binary immediately before
launch. The E2E launcher passes that resolved package binary as Playwright's explicit
`executablePath` so Playwright does not fall back to resolving Electron from its own package
directory. If CI still reaches the launcher with a missing `path.txt` or executable, the launcher
runs the same installer helper once, trusts the helper's validation, and passes the platform-specific
package executable path directly instead of importing `electron/index.js`.

Because several processes can reach that helper at once on one machine — `ensure-native.sh` from
`predev` / `prebuild` / `pretest:e2e`, plus each Playwright worker (`workers: 2`) — the
install is serialised with a lock file next to the `electron` package, and only one process
downloads: the others wait and reuse the finished install. The archive is extracted into a staging
directory beside `dist/` and swapped in with a rename, and `path.txt` is written last and never
deleted, so a concurrent `require('electron')` always sees either the previous install or the new
one. Without that, an install in flight makes unrelated Vitest suites fail at import time with
`Electron failed to install correctly`, which reads like a code regression rather than an
environment problem. A failed download now also leaves an existing install untouched. The behaviour
is covered by `node --test apps/desktop/scripts/install-electron-binary.test.cjs`, which runs
offline against a fixture archive.

Release builds create one staged dependency tree per macOS architecture. Build x64 on an Intel
runner and arm64 on an Apple Silicon runner; do not build `--x64 --arm64` from the same staged
package, because native modules are rebuilt for one target architecture at a time.

The macOS signing patch in `apps/desktop/scripts/patch-osx-sign-walk.js` walks the packaged app
serially. Keep that traversal bounded; unbounded parallel file reads can exhaust CI file descriptors
while scanning large dependency trees.

Linux release artifacts include the target architecture in both `.deb` and `.AppImage` filenames
so `x64`, `arm64`, and `amd64` builds stay distinguishable in GitHub releases.

## Coverage Targets

Desktop and sync-server enforce coverage floors, and the floors only move up. Keep new coverage
feature-scoped and avoid catch-all test files.

- **Desktop** — configured in `apps/desktop/config/vitest.config.ts`, with the floor in
  `apps/desktop/config/coverage-thresholds.json`. Vitest and the CI "Coverage thresholds" job
  (`apps/desktop/scripts/check-coverage-thresholds.mjs`) both read that file, so raise the
  numbers there.
- **Sync-server** — configured in `apps/sync-server/vitest.config.ts`; current floor is
  90% for statements, branches, functions, and lines.
- **Sync harness** — `tests/sync-harness` uses the same Vitest major as the sync server so
  encrypted sync E2E helpers stay on the same runner behavior as Worker tests.
- **PRs** — include the relevant coverage command output when raising or defending a
  threshold change.

## Known Test Files With Known Errors

- `websocket.test.ts`
- `folders.test.ts`
- `sync-telemetry.ts`

These have pre-existing TypeScript errors that don't reflect runtime issues. They're tracked and excluded from gating.

## CI Divergence Playbook

When E2E passes locally but fails in CI, walk through in order:

1. **Stale `out/`** — did the CI build succeed before tests?
2. **Error context** — `gh run download` to grab `error-context.md`.
3. **Timezone** — CI runs UTC; date assertions can flake.
4. **Native ABI** — CI rebuilds; check the Electron version is pinned.
5. **xvfb timing** — Electron windows need time to compose; bump waits.
