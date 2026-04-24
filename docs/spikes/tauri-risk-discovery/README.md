# Spike 0: Tauri Risk Discovery

**Duration:** 2026-04-24 → [end date]
**Status:** In progress
**Parent spec:** `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md`

## Purpose

Before starting memry's Electron → Tauri migration, this spike tests 3
architectural decisions with real code:

1. **S1** — Does BlockNote work correctly in system webview (WKWebView on macOS)?
2. **S2** — Where does Yjs live: renderer-owned or Rust (yrs)?
3. **S3** — Where does the database live: Rust-owned, plugin-sql, or hybrid?

## How to read this directory

- `findings.md` — overall Spike 0 summary and decisions
- `s1-blocknote-webview.md` — S1 detailed report
- `s2-yjs-placement.md` — S2 detailed report
- `s3-db-placement.md` — S3 detailed report
- `benchmarks/` — raw measurement data (JSON, CSV, screenshots)
- `scripts/` — reproducible benchmark runners

## Reproducing benchmarks

See `scripts/README.md`. Spike prototype code was deleted at end of spike;
scripts can run standalone against any new Tauri/memry code.

## Status

[To be filled in as spike progresses]
