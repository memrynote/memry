# M1 Visual Parity Baselines

Captured at the end of **M1 Phase J** (2026-04-25) as the reference visual
state of the ported Tauri renderer. These PNGs are the canonical M1 baseline
for later milestones to diff against — any regression past this point is
measurable against these frames.

## Generation

```bash
pnpm --filter @memry/desktop-tauri exec playwright test \
  e2e/specs/visual-baseline.spec.ts --reporter=list
```

The spec boots a clean Vite dev server against the M1 mock IPC router and
screenshots each primary route. Screenshots are deterministic because the
mock fixtures are frozen per-commit.

## Coverage

| File | Route / State | Notes |
|------|---------------|-------|
| `landing-tauri.png` | Fresh app launch — inbox list visible | Default post-onboarding view |
| `inbox-tauri.png` | Inbox route | 10 mock items with status mix |
| `journal-tauri.png` | Journal route | Heatmap + entries |
| `calendar-tauri.png` | Calendar route | Day/week/month/year switcher |
| `tasks-tauri.png` | Tasks route | Project picker + task list |
| `sidebar-tauri.png` | Sidebar in isolation | For granular typography checks |
| `notes-tree-tauri.png` | Notes tree with collections expanded | 3 folders × 12 notes |
| `command-palette-tauri.png` | Cmd+K palette open | Overlay + search input |
| `settings-modal-tauri.png` | Cmd+, settings modal | Dialog + tabs |
| `onboarding-wizard-tauri.png` | First-run Welcome splash | Pre-dismissal state |

## Electron parity

Paired `*-electron.png` frames are **not** included. Playwright WebKit cannot
exercise the Electron renderer without launching the Electron binary, which
is out of scope for M1. Parity review is manual:

1. Launch Electron: `pnpm --filter @memry/desktop dev`
2. Navigate to each route in the real Chromium window.
3. Capture with `Cmd+Shift+4` → window (macOS).
4. Compare side-by-side with the `*-tauri.png` frame from this directory.

Known differences to expect (not regressions):

- WebKit renders fonts with slightly different hinting vs Chromium. Character
  widths can differ by ±1 px on small sizes. Acceptable.
- Tauri window chrome ships the macOS title bar traffic lights in a
  fixed-overlay div (WindowControls); Electron uses its own. The 28px top
  band layout is identical.
- "Invalid Date" strings in inbox/journal items — known mock-shape issue
  (timestamps vs ISO) tracked as M2 cleanup, not a visual regression.

## Refresh

Re-run the visual-baseline spec whenever the renderer CSS, mock fixtures,
or component library changes materially. Overwrites the PNGs in place.
