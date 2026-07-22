# Spatial Canvas M7 — Rollout — Design

Date: 2026-07-22 · Branch: `spatial-canvas-m7-rollout` · Base: `main` @ `166e75d37`

Master spec: `docs/superpowers/specs/2026-07-17-spatial-canvas-design.md` (§13 M7, §16, §5.3, §11).
M6 design: `docs/superpowers/specs/2026-07-21-spatial-canvas-m6-live-editing-design.md` (§12 items 5–6, R17).

## 0. Context

M0–M6 are merged to main. The canvas surface exists, syncs end-to-end, externalizes assets, and
supports in-place live editing — but it is hidden behind `spatialCanvas`, which defaults to `false`.

M7 adds **no new canvas capability**. It closes the pre-default-on hardening gaps, makes the rollout
observable and documented, and flips the default only after a soak.

### Entry gate — verified on `main` @ `166e75d37`, not re-done

| Item                                                    | State                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spatialCanvas` in `FEATURE_KEYS`                       | ✅ `packages/contracts/src/feature-flags.ts:12`                                                                                                                                                                                                                                        |
| Default `false` in `FEATURES_SETTINGS_DEFAULTS`         | ✅ `packages/contracts/src/settings-schemas.ts:239`                                                                                                                                                                                                                                    |
| `feature-flags.test.ts` asserts the 7-key shape         | ✅ `packages/contracts/src/feature-flags.test.ts:6`                                                                                                                                                                                                                                    |
| Settings > Features toggle                              | ✅ renders automatically — `features-section.tsx:20` maps `FEATURE_KEYS`                                                                                                                                                                                                               |
| i18n `features.items.spatialCanvas.{label,description}` | ✅ `packages/i18n/src/locales/en/settings.json:48`                                                                                                                                                                                                                                     |
| #754 sync-type negotiation merged                       | ✅ `97218fe43`; `SYNC_TYPES_HEADER` middleware + all three call sites filtered (`services/sync.ts:528` manifest, `:570` changes, `:696` pull)                                                                                                                                          |
| Telemetry already wired                                 | `canvas_too_large` (`main/canvas/sync-bridge.ts:55`), `canvas_sync_conflict_copy` (`main/sync/item-handlers/canvas-handler.ts:422`), `sync_skipped_unknown_type` (`main/sync/apply-item.ts:40`), `canvas_asset_{uploaded,dedup_hit,gc_reaped}` (`main/canvas/assets/asset-service.ts`) |
| Missing telemetry                                       | ❌ `canvas_created`, `canvas_opened`; no `canvas` value in `TelemetrySurfaceSchema`                                                                                                                                                                                                    |
| User docs                                               | ❌ zero canvas coverage under `apps/docs/src`                                                                                                                                                                                                                                          |
| Unauth split-view guard                                 | ❌ not built                                                                                                                                                                                                                                                                           |

So M7's "promote the flag to `FEATURE_KEYS` + Settings + i18n" is **already satisfied**. It is verified,
not rebuilt. The real M7 work is the guard, the telemetry, the docs, and the flip decision.

## 1. Decisions locked (2026-07-22)

1. **Two PRs.** PR A = opt-in hardening (flag stays default-off). PR B = the default-on flip alone,
   opened only after the soak and an explicit go/no-go.
2. **Unauth guard shape: the tab always wins.** A canvas card refuses to activate; it stays an idle
   read-only preview and offers an "open in tab" affordance.
3. **Card-vs-card is also guarded**, via a module-level claim registry — not just tab-vs-card.
4. **Telemetry goes all the way:** add `canvas_created` + `canvas_opened` events and a `canvas`
   surface. Server deploys first.
5. **Docs:** a real `apps/docs/src/user-guide/canvas/` section, cross-linked; no `MEMRY_DOCS_IMPACT_SKIP`.
6. **Soak:** ≥ 1 released opt-in build and ≥ 7 days clean before the flip.
7. **Grafana dashboards are provisioned by hand.** The panel queries are committed to
   `apps/docs/src/architecture/observability.md`; creating the Grafana panels is Kaan's manual step.
   Nothing in this repo can provision Grafana Cloud, and pretending otherwise would be a false green.

## 2. Non-goals

- No new canvas editing/authoring features. M7 is rollout, not scope growth.
- No sync payload shape, crypto primitive, DB schema, or migration changes.
- No changes to the authenticated in-place co-editing path (shared Y.Doc) beyond added test coverage.
- No Excalidraw version bump, no `renderEmbeddable` work (R19 stays closed).

## 3. The unauthenticated split-view guard (M6 §12 item 6)

### 3.1 Why it exists

`ContentArea` enables Yjs collaboration only when `syncActive` — status `idle | syncing | offline`,
reachable only for an authenticated sync session (`ContentArea.tsx:1334`, `sync-context.tsx:227`).
Unauthenticated users therefore edit through a **non-collaborative** BlockNote instance that
debounce-saves markdown via `onMarkdownChange`.

Before M6 this was harmless: one surface per note. M6's active card makes a second live editor for
the same note reachable whenever both panes are mounted at once. Two consequences, one envelope:

- **Body clobber.** Two independent markdown editors, last-save-wins. Lost edits, silently.
- **Duplicate task auto-conversion.** `isSideEffectOwner` defaults to `true` when collaboration is
  disabled, so _both_ `ContentArea`s run task auto-conversion on their own `onChange`.

Both are gated on the _same_ precondition — a second live editor existing — so one guard closes both.

### 3.2 The predicate

```
locked(noteId) = !collaborationActive
              && ( noteOpenInVisibleTab(noteId) || claimedByAnotherCard(noteId) )
```

- **`collaborationActive`** is today an inline expression at `ContentArea.tsx:1334`. Extract it to a
  pure `isCollaborationActive(status: SyncStatus): boolean` helper and have **both** `ContentArea`
  and the canvas guard read it. Two independently-maintained copies of this predicate would drift,
  and a drift here means the guard silently stops matching the condition it is guarding.
- **`noteOpenInVisibleTab`** — true when any `TabGroup`'s **active** tab is `type: 'note'` with
  `entityId === noteId`. `tab-pane.tsx:56` renders only `group.tabs.find(t => t.id === group.activeTabId)`,
  so a background tab in the same group is unmounted and cannot clobber anything. Checking active
  tabs only is therefore exact, not an approximation.
- **`claimedByAnotherCard`** — a module-level `Map<noteId, cardElementId>`. A card claims on
  activation and releases on deactivation/unmount; a card that cannot claim is locked. This covers
  the case the tab check misses: two canvas tabs in split view showing the same note's card, both
  double-clicked. Modelled on the existing `sync/yjs-doc-registry.ts` ref-counting pattern.

Authenticated users never satisfy the first conjunct, so their behavior is byte-identical to M6:
the shared Y.Doc keeps full in-place co-editing.

### 3.3 Behavior

On double-click of a locked card, `canvas-card-overlay.tsx` does **not** dispatch `activate`. The
card stays idle and renders in a locked variant:

- `data-canvas-card-locked="true"` on the card root (E2E hook).
- A small footer affordance — "Open in tab to edit" — wired to the existing `onRedirect` /
  `buildRedirectTab` path. No new IPC, no new tab kind.
- The affordance must be `pointer-events-auto` on a `pointer-events-none` card body, exactly like
  the existing ↗ button at `canvas-card.tsx:63`, or canvas pan/draw will swallow it.
- Double-click on a locked card is a **no-op**, not an implicit redirect. Matrix #20 asserts that
  ↗ and double-click never cross-fire; making double-click redirect would break that invariant.

The lock badge is persistent while the condition holds, not a flash on failed activation — the user
should be able to see _why_ the card is not editable without probing it.

### 3.4 Files

New:

- `renderer/src/pages/canvas/canvas-note-lock.ts` — pure `evaluateNoteLock(...)` decision function
  plus the claim registry (`claimNoteCard` / `releaseNoteCard` / `isClaimedByOther`). Excalidraw-free
  and React-free so it unit-tests in jsdom, matching `canvas-active.ts`.
- `renderer/src/pages/canvas/canvas-note-lock.test.ts`.

Edited:

- `components/note/content-area/ContentArea.tsx` — replace the inline `syncActive` expression with
  the extracted helper (behavior-preserving).
- `pages/canvas/canvas-card-overlay.tsx` — evaluate the lock in the dblclick branch; pass `locked`
  down; claim on activate, release on deactivate/unmount.
- `pages/canvas/canvas-card.tsx` — additive `locked?: boolean` prop + the affordance.
- `packages/i18n/src/locales/en/common.json` — `canvas.card.lockedHint` / `canvas.card.openInTab`.

### 3.5 Tests

- **Unit (jsdom).** `evaluateNoteLock` truth table across auth × open-in-visible-tab × claimed:
  authenticated is never locked (all four combinations); unauthenticated locks iff a visible note tab
  or a foreign claim exists; a card's _own_ claim does not lock itself (re-activation is allowed);
  claim/release round-trips; releasing a claim you do not own is a no-op.
- **Unit (jsdom).** `canvas-card.tsx` renders the affordance and `data-canvas-card-locked` only when
  `locked`.
- **E2E (`canvas-editing.e2e.ts`).** The E2E vault runs unauthenticated, which is exactly the guarded
  path. Split view with the note tab in one pane and the canvas in the other: double-click the card →
  assert it never reaches `data-canvas-card-state="active"`, assert no second editor mounts, edit in
  the tab and assert `notes.get` keeps that edit. This is the regression that proves no clobber.
- The authenticated co-edit path stays covered by the registry unit tests, per the M6 §12/5 coverage
  split (authenticated-sync E2E fixtures remain out of scope).

## 4. R17 registry re-verification (M6 §12 item 1b)

No behavior change — this produces evidence. `sync/yjs-doc-registry.ts` sits on the core note-editing
path, so a leak here hits every note tab once the flag is on for everyone. Add churn tests:

- Interleaved acquire/release across several consumers for one note leaves `refCount` exact.
- Releasing the current `sideEffectOwner` while others remain promotes exactly one survivor.
- `refCount → 0` destroys provider and doc exactly once (one `closeDoc`).
- A duplicate/late release does not drive `refCount` negative or double-destroy.
- The `refCount === 1` parity claim still holds: one create on mount, one destroy on unmount.

## 5. Telemetry

Additions to `packages/contracts/src/telemetry-api.ts`:

- `TelemetryEventNameSchema` += `canvas_created`, `canvas_opened`.
- `TelemetrySurfaceSchema` += `canvas`.

Emission (main process, existing `trackMainEvent` pattern, mirroring the shape already used by
`canvas_too_large`):

- `canvas_created` — `CanvasChannels.invoke.CREATE` handler (`main/ipc/canvas-handlers.ts:89`),
  `{ surface: 'canvas', action: 'create', objectType: 'canvas', result: 'success' }`.
- `canvas_opened` — `CanvasChannels.invoke.GET` handler (`main/ipc/canvas-handlers.ts:106`),
  `{ surface: 'canvas', action: 'open', objectType: 'canvas', result: 'success' }`.

`canvas_opened` fires per successful load, so a tab-switch remount counts again. That is the intended
meaning ("canvas loads"), and it is documented in `observability.md` so nobody later reads it as
distinct-canvas-opens.

No dimensions, no free-form fields, no identifiers — `SafeDimensionValueSchema` is respected by
construction because nothing variable is attached.

**Deploy order is mandatory.** The sync-server validates `/telemetry/batch` with the _same shared_
`TelemetryBatchSchema` from `@memry/contracts` (`apps/sync-server/src/routes/telemetry.ts:28`), so a
deployed server running older contracts rejects the **entire batch** — not just the unknown event —
with a 400. Sequence: merge PR A to `main` → sync-server auto-deploys via GitHub Actions → verify the
deploy → only then cut a desktop release. Local dev builds pointed at production before that deploy
will have their telemetry batches rejected; that is dev-only and acceptable.

Grafana/AE panel queries (adoption, conflict-copy rate, `canvas_too_large`, `sync_skipped_unknown_type`)
are committed to `apps/docs/src/architecture/observability.md`. Creating the panels in Grafana Cloud
is a manual step for Kaan; this repo cannot do it.

## 6. Documentation

New `apps/docs/src/user-guide/canvas/`:

1. `overview.md` — what a canvas is, enabling it in **Settings > Features** (it is opt-in in this
   phase), creating/opening one, the sidebar section, drawing basics.
2. `cards-and-links.md` — dragging notes onto a canvas, capture-first new notes, task/event cards,
   live titles, dangling cards, connecting cards with arrows, ↗ open-in-tab vs double-click-to-edit,
   and the unauthenticated "open in tab to edit" lock from §3.
3. `sync-and-limits.md` — end-to-end encrypted cross-device sync, conflict copies (canvases are
   last-write-wins with a conflict copy, not real-time co-editing), images and the scene size cap,
   and the honest limitations (palm rejection, Excalidraw's own UI language).

Plus: `.vitepress/config.ts` sidebar entry; cross-links from `features.md`, `user-guide/settings.md`,
`user-guide/tabs-split-view.md`, and `roadmap.md`.

Gate: `pnpm docs:impact --base origin/main --strict` and `pnpm docs:build` green, with no
`MEMRY_DOCS_IMPACT_SKIP`. `scripts/docs-impact.mjs` only requires that a desktop/sync-server change
ships alongside some `apps/docs/src/**` change, so this satisfies it — the point of writing real pages
rather than a stub is that default-on gives every install this surface.

## 7. PR B — the default-on flip

Contents, deliberately minimal so the revert is trivial:

- `FEATURES_SETTINGS_DEFAULTS.spatialCanvas: false → true` (`settings-schemas.ts:239`).
- `feature-flags.test.ts:14` expectation updated to `spatialCanvas: true`.
- The comment at `settings-schemas.ts:225` and the "opt-in" wording in the new docs updated.

### Go/no-go — every item must be green before PR B opens

1. §3 guard merged; its unit and E2E tests green.
2. §4 registry churn tests green.
3. #754 confirmed **live in the deployed sync-server**, not merely merged — all three of
   `/sync/changes`, `/sync/pull`, `/sync/manifest` filtering by `X-Memry-Sync-Types`. Without this,
   default-on puts canvas rows in front of every released client and R3's 30-minute full-re-pull
   storm becomes fleet-wide.
4. Telemetry live: the contracts change deployed to the sync-server, and `canvas_created` /
   `canvas_opened` actually visible in AE.
5. Soak: ≥ 1 released opt-in build, ≥ 7 days, with `canvas_sync_conflict_copy` at a sane rate, no
   `canvas_too_large` or `sync_skipped_unknown_type` spike, no canvas-attributed errors in Loki, and
   at least a handful of real users having opened a canvas.
6. Rollback rehearsed: toggling the flag off removes the surface immediately in a running app.

### Rollback

Flag off disables the surface instantly. The server keeps accepting `canvas` rows — harmless, since
older desktops filter them by negotiated type. Tables are additive and inert when the flag is off, so
there is no schema rollback. If a desktop build must be pulled, server-side data is untouched.

## 8. Backward compatibility

- No DB migration, no schema change, no sync payload change, no crypto change.
- Settings shape is unchanged: `spatialCanvas` already exists in the schema and defaults, so old
  settings blobs already merge cleanly. PR B changes only the default for installs that never wrote
  the key — a user who explicitly turned it **off** keeps it off, because the stored value wins.
- IPC contracts are untouched; `pnpm ipc:check` should need no regeneration. The telemetry enum
  additions are additive and validated server-first.
- The `ContentArea` change is a pure extraction of an existing expression.

## 9. Risks

| #    | Risk                                                                                                     | Sev         | Mitigation                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M7-1 | Telemetry enum lands on desktop before the server deploy → every batch 400s, all telemetry blind         | **high**    | Merge-then-deploy-then-release order in §5; verify the deploy before cutting a release                                                   |
| M7-2 | `isCollaborationActive` extraction subtly changes `ContentArea`'s gate → note editors break for everyone | **high**    | Pure extraction, no logic edit; existing ContentArea tests must stay green untouched                                                     |
| M7-3 | Claim registry leaks a claim (card unmounts without releasing) → note permanently locked on canvas       | med         | Release in an effect cleanup keyed to the card id; unit-test release-on-unmount; a stale claim degrades to read-only, never to data loss |
| M7-4 | Lock predicate misjudges visibility if tab rendering ever changes to keep background tabs mounted        | med         | Predicate is centralized in one pure function with a comment pinning the `tab-pane.tsx:56` assumption                                    |
| M7-5 | Default-on lands before #754 is confirmed deployed → fleet-wide re-pull storm                            | **blocker** | Go/no-go item 3; PR B is separate precisely so this cannot ride along unnoticed                                                          |
| M7-6 | Coverage ratchet reddens from new untestable canvas glue                                                 | low         | Logic lives in the pure `canvas-note-lock.ts`; the overlay/card edits stay thin                                                          |

## 10. Verification

```
pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check
pnpm check:architecture && pnpm check:contracts
pnpm test:desktop && pnpm test:sync-server
pnpm docs:impact --base origin/main --strict && pnpm docs:build
```

Plus the targeted E2E from §3.5. New UI uses logical Tailwind properties (`ms/me`, `ps/pe`,
`start/end`) per the repo rule.

CI runs the PR merged with `main`. If a check is red, confirm whether `main` is red for the same
reason before assuming this branch caused it.
