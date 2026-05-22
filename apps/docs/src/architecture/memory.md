# Memory Benchmarks

Memry desktop memory benchmarks run against the development Electron app. They never use a
production build.

## Test Vault

Use `~/sideproject/vaults/MemryA` for every capture in the memory-footprint PR series. The
snapshot CLI opens that vault through the local debug control server and then confirms the active
vault before any sample is captured. If the active vault still differs, the command aborts.

## Debug Harness

Start the desktop app with the memory harness enabled:

```bash
MEMRY_DEBUG_MEMORY=1 pnpm --filter @memry/desktop dev
```

The app binds a local control server to `127.0.0.1:17345`. Override the port with
`MEMRY_DEBUG_MEMORY_PORT` when another local process already uses it. The server is available only
when `MEMRY_DEBUG_MEMORY=1`.

The harness records:

- main-process `process.memoryUsage()` values
- renderer heap values from the visible Electron window
- `performance.measureUserAgentSpecificMemory()` when Chromium exposes it
- direct child-process RSS values reported by `ps`
- metadata for vault path, scenario, branch, label, hostname, and capture time

## Capture Workflow

In another shell from the same worktree:

```bash
MEMRY_DEBUG_MEMORY=1 pnpm memory:snapshot \
  --scenario boot \
  --vault ~/sideproject/vaults/MemryA \
  --label feat
```

The command writes `tmp/memory/<label>-<scenario>-<timestamp>.json` at the repo root. Each file
contains T0, T1, and T2 samples. The CLI reopens the requested vault for each run, waits 5 seconds
for post-open renderer work to settle, then records T0. `boot` captures T1 immediately after T0,
then T2 after 60 seconds idle. `idle-60s` waits 60 seconds before T1 and another 60 seconds before
T2.

## Compare Workflow

Capture the same scenario on `main` and the feature branch on the same machine, within the same
hour:

```bash
pnpm memory:compare tmp/memory/main-baseline-boot-*.json tmp/memory/feat-boot-*.json
```

The comparison prints per-phase, per-process, per-metric deltas in MiB and percent. Attach both JSON
files and the comparison output to the draft PR.
