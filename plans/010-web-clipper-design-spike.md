# Plan 010: Produce the web clipper design spec — transport decision, clip contract, extension scaffold plan, and store-submission timeline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- packages/contracts/src/inbox-api.ts apps/desktop/src/main/inbox/capture.ts apps/desktop/src/main/agent/mcp/server.ts apps/desktop/src/main/agent/mcp/session.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (spike + spec; the extension build it specifies is M–L and is NOT part of this plan)
- **Risk**: LOW (this plan produces a design document; no source code changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `86ee0cd1`, 2026-06-13

## Why this matters

The web clipper is listed as **Active** on the public roadmap (`apps/landing/src/pages/Roadmap.tsx:33-36`: "Save pages, highlights, and snippets straight into your Inbox from any browser") and the contract layer was built anticipating it — yet zero extension or intake-endpoint code exists. There is a hidden deadline: Chrome Web Store review takes days to weeks, so for a clipper to exist at the end-of-July public launch, the extension must be submitted well in advance. This plan does NOT build the clipper; it produces the design spec, decides the transport architecture, and defines the clip contract so a build plan can start immediately.

## Current state

The plumbing already anticipates clips at every layer:

- `packages/contracts/src/inbox-api.ts:33` — `export type CaptureSource = 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'`
- `packages/contracts/src/inbox-api.ts:27` — `'clip'` is already an inbox item type (alongside `'pdf'`, `'social'`).
- `packages/contracts/src/inbox-api.ts:85-92` — the clip payload contract already exists:

```ts
export interface ClipMetadata {
  sourceUrl: string
  sourceTitle: string
  quotedText: string
  selectionContext?: string
  capturedImages: string[]
  hasFormatting: boolean
}
```

- `apps/desktop/src/main/inbox/capture.ts:6` — module header says "(Future: images, PDFs, clips)"; today only voice capture is implemented in this module. The Zod schema at `capture.ts:52` already accepts `source: 'browser-extension'`.
- **Existing localhost-server precedent** — the Agent MCP server in the main process is the architectural exemplar for a token-authenticated local endpoint:
  - `apps/desktop/src/main/agent/mcp/server.ts:78-79` — strips `Bearer ` prefix and calls `session.verifyToken(bearer)`; rejects otherwise.
  - `apps/desktop/src/main/agent/mcp/server.ts:116` — `server.listen(0, '127.0.0.1', ...)` (loopback only, ephemeral port).
  - `apps/desktop/src/main/agent/mcp/session.ts:30-37` — token minted in-memory, rotatable.
  - A Settings panel already shows the MCP URL + token with copy/rotate (per `docs/goal.md` P1 acceptance criteria) — the clipper pairing UX can mirror it.
- E2E constraint: the sync server is a ciphertext relay (it never sees plaintext). Any clip path that transits the sync server must be encrypted client-side; the extension does not hold vault keys.
- Design-spec convention: `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`; structural exemplar `docs/superpowers/specs/2026-06-12-inbox-upcoming-reminders-panel-design.md`.

## Commands you will need

| Purpose                     | Command                                                                                                  | Expected on success                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Confirm no extension exists | `ls apps/ \| grep -i "clip\|extension"`                                                                  | no matches                                   |
| Confirm capture sources     | `grep -n "browser-extension" packages/contracts/src/inbox-api.ts apps/desktop/src/main/inbox/capture.ts` | matches at the cited lines                   |
| Lint (unchanged)            | `pnpm lint`                                                                                              | exit 0                                       |
| Working tree check          | `git status --porcelain`                                                                                 | only the new spec file + plans/README.md row |

## Scope

**In scope** (the only files you may create or modify):

- `docs/superpowers/specs/2026-06-13-web-clipper-design.md` (create)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch):

- Any file under `apps/desktop/src`, `apps/sync-server/src`, `packages/*/src` — spec-only spike.
- The Agent MCP server files — the spec may propose reusing the _pattern_; do not modify the server.
- Firefox/Safari ports — name them in "Later phases" only.

## Git workflow

- Branch: `web-clipper-design-spec` (repo rule: code-context branch names, no agent branding).
- Commit style: conventional commits, e.g. `docs(specs): web clipper design spec`. Do NOT add Co-Authored-By lines.
- Do NOT push or open a PR unless the operator instructed it. If pushing and the pre-push docs gate blocks, `MEMRY_DOCS_IMPACT_SKIP=1` is acceptable for this spec-only change.

## Steps

### Step 1: Decide the transport (the load-bearing decision)

Document all three candidates with trade-offs, then pick one with rationale:

- **A. Dedicated localhost HTTP endpoint in the main process** (mirror of the MCP server pattern: loopback + bearer token, fixed or discoverable port). Pros: simplest, reuses proven pattern, clip lands instantly with full domain-layer access. Cons: desktop app must be running; extension needs the port (fixed port vs. port-file discovery — note the MCP server uses an ephemeral port, which an extension cannot discover; the spec must solve this, e.g. a fixed default port with fallback range).
- **B. Sync-server relay** (extension POSTs to a new sync-server route; desktop pulls). Pros: works when desktop is closed. Cons: violates or strains E2E (server would see plaintext clips unless the extension encrypts, and the extension has no vault keys) — likely disqualifying for v1; document why.
- **C. Chromium native messaging host**. Pros: no open port, OS-brokered. Cons: requires a registered native host binary + manifest install per browser/OS, complicates packaging.

The recommendation to evaluate first: **A**, with an offline queue in the extension (retry until the app is up) to soften the "app must be running" con.

**Verify**: spec contains a "Transport decision" section with a comparison table of A/B/C and a single picked option with ≥3 lines of rationale.

### Step 2: Define the clip contract and intake behavior

- Map the extension payload onto `ClipMetadata` (`inbox-api.ts:85-92`) — state what fills `quotedText` vs `selectionContext`, when `hasFormatting` is true, and how `capturedImages` are transmitted (inline base64 vs skipped in v1).
- Decide where HTML→Markdown conversion happens: extension-side (Readability + turndown — keeps the desktop intake dumb) vs app-side (desktop already has serializer machinery). State the recommendation and why.
- Define the intake function: a new `captureClip` handler in `apps/desktop/src/main/inbox/capture.ts` following the existing voice-capture shape (Zod schema, `source: 'browser-extension'`, inbox event emit, projection publish). The spec describes its input schema; the build plan implements it.
- Pairing UX: token display/copy/rotate in Settings, mirroring the MCP panel; clip rejected with 401 on bad token (mirror `server.ts:78-79`).

**Verify**: spec contains "Clip contract" and "Pairing & auth" sections; the contract section names every `ClipMetadata` field.

### Step 3: Specify the extension itself

- MV3 scaffold location: new workspace app (recommend `apps/clipper`), build tooling consistent with the repo (Vite, TypeScript, Prettier config: single quotes, no semicolons, 100 chars).
- Surfaces for v1: toolbar-button full-page clip, context-menu selection clip. Defer: highlights overlay, screenshot region.
- Offline queue: clips persisted in `chrome.storage.local`, flushed with retry/backoff when the desktop endpoint answers.
- Permissions list (keep minimal — `activeTab`, `contextMenus`, `storage`, `scripting`) and the privacy-policy implications for store listing.

**Verify**: spec contains an "Extension scaffold" section including the MV3 permissions list.

### Step 4: Store-submission timeline and risks

Write a "Launch timeline" section: package + store-listing assets + privacy policy → submit to Chrome Web Store with explicit lead-time buffer (assume 1–3 weeks review; resubmission risk if permissions look broad), working back from end-of-July. Add "Open questions" (each with a recommended answer) and "Later phases" (Firefox/Safari, highlights, mobile share-sheet relation).

**Verify**: spec file contains sections: Problem, Transport decision, Clip contract, Pairing & auth, Extension scaffold, Launch timeline, Open questions, Later phases.

## Test plan

No code tests — this plan ships a spec. The spec must define the build plan's test plan: intake handler unit tests (valid clip, bad token 401, oversized payload), an E2E that POSTs a fixture clip to the local endpoint and asserts the inbox item appears, and an extension-side queue flush test.

## Done criteria

- [ ] `docs/superpowers/specs/2026-06-13-web-clipper-design.md` exists with all eight sections from Step 4's verify
- [ ] Transport decision is singular and justified (no "we could do either")
- [ ] `git status --porcelain` shows only the spec file and `plans/README.md`
- [ ] `pnpm lint` exits 0
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:

- An extension or clip-intake endpoint already exists anywhere in the repo (someone started; reconcile instead of spec'ing over them).
- The MCP server pattern has materially changed from the excerpts (different auth model) — the pairing design must follow the live pattern.
- You find evidence of a decided transport in any `docs/superpowers/specs/*.md` that contradicts Step 1's analysis — surface the contradiction, do not silently pick.

## Maintenance notes

- If transport A (localhost endpoint) is chosen, a future firewall-prompt issue on Windows/macOS is the thing to watch in QA — document the expected OS prompts in the spec.
- Reviewer should scrutinize: the fixed-port discovery story (the single biggest practical failure mode) and the permissions list (store review risk).
- Explicitly deferred: Firefox/Safari, highlight-overlay UX, clip-to-note (v1 clips land in inbox only, consistent with the capture-then-triage model).
