# S1: BlockNote + WKWebView — Findings

## Metadata
- **Spike:** Spike 0 — Tauri Risk Discovery
- **Sub-spike:** S1 — BlockNote + WKWebView
- **Date:** [To be filled during S1 execution]
- **Runner:** Claude Code (autonomous) + Kaan (manual tests + checkpoint review)
- **Commit:** [spike branch commit]
- **Duration:** [hours]

## Hypothesis

BlockNote 0.47.x in Tauri 2.x's macOS WKWebView provides UX parity with Electron
Chromium for core editing scenarios: typing, paste, IME, slash menu, images,
undo/redo.

**Null hypothesis (red):** At least one critical scenario exhibits silent data
loss or corruption — invalidates migration foundation.

## TL;DR — Decision

[🟢 / 🟡 / 🔴] — [To be filled during S1 execution]

[2-3 sentence summary]

## Setup

[Description of `spikes/tauri-risk-discovery/app/`, links, versions]

## Test matrix results

| # | Scenario | macOS | Windows | Notes |
|---|----------|-------|---------|-------|
| 1 | ASCII typing | [pending] | [pending] | |
| 2 | Turkish typing | [pending] | N/A | |
| 3 | IME Japanese (manual) | [pending] | N/A | |
| 4 | Paste plain text 500 char | [pending] | [pending] | |
| 5 | Paste rich HTML (manual) | [pending] | [pending] | |
| 6 | Paste image clipboard | [pending] | N/A | |
| 7 | Drag-drop image file | [pending] | N/A | |
| 8 | Slash menu | [pending] | [pending] | |
| 9 | Undo/redo 10-op chain | [pending] | [pending] | |
| 10 | Table editing | [pending] | N/A | |
| 11 | Code block | [pending] | N/A | |
| 12 | Link insertion | [pending] | N/A | |
| 13 | Large doc stress 10k char | [pending] | N/A | |
| 14 | Window resize (manual) | [pending] | N/A | |
| 15 | @react-sigma graph (manual) | [pending] | N/A | |

## Benchmark data

See `benchmarks/s1-feature-matrix.csv` for full grid.

Key numbers:
- Large doc typing latency p95: [pending] ms (threshold < 50ms)

## Observations

[Surprises, edge cases, interesting findings — filled during execution]

## Decision + rationale

[🟢/🟡/🔴 verdict + 2-3 sentence justification based on test results]

## Subsequent subproject impact

- **Subproject 1 (Tauri skeleton):** [implications]
- **Subproject 2 (DB):** [implications, e.g., paste handler metascraper integration]

## References

- BlockNote docs: https://www.blocknote.dev/
- Tauri webview docs: https://v2.tauri.app/plugin/webview/
- [GitHub issues referenced during execution]
