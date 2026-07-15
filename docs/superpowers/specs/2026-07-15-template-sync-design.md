# Custom Template Sync — Design

**Date:** 2026-07-15
**Branch:** `template-sync`
**Status:** Approved, ready for planning

## Problem

Custom templates do not sync between devices. A template authored on one Mac is invisible on every other device.

Templates live as markdown files in `vault/.memry/templates/*.md` (`apps/desktop/src/main/vault/templates.ts`). `.memry/` is excluded from the vault watcher (`vault/watcher.ts:177`), there is no `template` entry in `SYNC_ITEM_TYPES`, and there is no handler in `sync/item-handlers/`.

This is already inconsistent rather than merely absent: `journal.defaultTemplate` is a settings key (`main/ipc/settings-handlers.ts:79`) and `settings` **is** a synced type. Setting a custom journal template on device A syncs a `defaultTemplate` id to device B that points at a template file which does not exist there — a dangling reference.

## Blocker discovered during design: new sync types break already-shipped clients

Adding a sync item type is a well-trodden ~14-file pattern. The hazard is what a new type does to binaries already in users' hands.

Evidence chain:

1. `/sync/changes` is fetched with `getFromServer<RecordChangesResponse>` (`sync/engine/pull-coordinator.ts:246`). `getFromServer<T>` → `syncFetch<T>` (`sync/http-client.ts:144`) is a **generic cast with no runtime validation** — an old client accepts a `template` ref without complaint.
2. `pullChangesPage` maps **every** ref to an id with no type filter: `changes.items.map((item) => item.id)` (`pull-coordinator.ts:268`).
3. `processPage` POSTs those ids to `/sync/pull`; the response contains the template item.
4. `RecordPullResponseSchema.safeParse(pullResult.value)` (`pull-coordinator.ts:452`) validates the **entire page at once**. `template` is absent from an old binary's `z.enum(RECORD_SYNC_ITEM_TYPES)`, so the whole page fails and the method returns `applied: 0`.
5. The server's `getChanges(c.env.DB, userId, cursor, limit, vaultId)` (`apps/sync-server/src/routes/sync.ts:274`) applies no type filter, and `updateDeviceCursor` advances the device cursor whenever changes are returned.

**Consequence:** an old client sharing a vault with an upgraded client silently drops entire pages of notes and tasks, and its cursor advances past them. This is convergence loss, not a recoverable stall, and it lands on exactly the cohort this feature targets — multi-device users with custom templates.

**This invalidates an assumption in the existing mobile plan.** `docs/superpowers/plans/2026-07-14-server-desktop-additive-d6-d8.md:1873` states: _"old clients simply never pull types they don't register."_ They do pull them. That claim underpins the `home_page` / `bookmark` / `reminder` types in the mobile program, so this fix is a shared prerequisite.

Released binaries cannot be retroactively patched. **Only a server-side change protects them.**

## Decisions

| #   | Decision                                                        | Rationale                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Server-side sync-type filtering, negotiated per request         | The only mechanism that protects binaries already in the wild. Also unblocks the mobile program's three new types.                                                                                                                                 |
| D2  | DB is the sole source of truth; built-ins become code constants | `.memry/` is app-private (it holds `data.db`, excluded from the watcher), so file storage was convenience, not philosophy. `BaseItemHandler.buildPushPayload` is synchronous, so file-backed truth would force `readFileSync` on the main process. |
| D3  | Built-in templates never sync                                   | Fixed ids, identical on every device, already immutable (`updateTemplate`/`deleteTemplate` reject them). Syncing them would fight the seeder.                                                                                                      |
| D4  | Whole-row LWW (`clock` only, no `fieldClocks`)                  | Templates are not concurrently field-edited. `fieldClocks` on a simple type is unneeded complexity.                                                                                                                                                |
| D5  | Migration preserves the id from file frontmatter                | Ids must never be regenerated, so a vault copied across devices (Dropbox/iCloud) converges by LWW instead of duplicating.                                                                                                                          |

## Architecture

### Part 1 — Sync-type capability negotiation (prerequisite, server-first)

**Client:** `http-client.ts` sends `X-Memry-Sync-Types: note,task,…,template` on `/sync/changes`, `/sync/manifest`, and `/sync/pull`, mirroring the existing `X-Memry-Vault-Id` header pattern.

**Server:** those three routes filter `item_type` to the negotiated list. **A missing header falls back to a frozen `LEGACY_SYNC_ITEM_TYPES` constant** — today's 16 types:

```
note, task, project, settings, attachment, inbox, filter, journal,
tag_definition, folder_config, calendar_event, calendar_source,
calendar_binding, calendar_external_event, agent_conversation, agent_message
```

This constant is frozen forever. It is never edited when a new type is added; that is the whole point.

**Cursor correctness — resolved, no change needed.** An earlier draft of this spec claimed `nextCursor` had to be derived from the maximum _scanned_ `serverCursor` or old clients would stall on all-filtered pages. **That was wrong.** `getChanges` (`apps/sync-server/src/services/sync.ts:553-610`) already applies `item_type IN (...)` in SQL, **before** `LIMIT`:

```sql
WHERE user_id = ? AND vault_id = ? AND server_cursor > ? AND item_type IN (${placeholders})
ORDER BY server_cursor ASC
LIMIT ?
```

Filtered-out rows therefore never enter the result set, and a page is always full of allowed rows up to the limit. `nextCursor = pageRows[pageRows.length - 1]?.server_cursor ?? cursor` steps over excluded rows for free and never rewinds. If every remaining row is a template, the page is simply empty, `hasMore` is false, and the client correctly stops — there is nothing to stall on. The existing cursor design is correct as-is.

What this changes: the type-filtering machinery (`RECORD_SYNC_ITEM_TYPE_PLACEHOLDERS` + the `item_type IN (...)` bind) **already exists**. The server filters against its own compile-time `RECORD_SYNC_ITEM_TYPES` — which is exactly the bug, since deploying a server whose contracts include `template` makes it serve template refs to every client. Plan A is therefore a narrow change: make that list per-request instead of compile-time constant.

**Client-side hardening (defence in depth):** new clients also filter unknown types out of `changes.items` before building `itemIds`. This does not help already-shipped binaries — only D1 does — but it stops a future type from breaking this generation of clients if the header path ever regresses.

**Deploy order (hard rule):** sync-server to production **before** any desktop build carrying the `template` type reaches users.

### Part 2 — `template` as a record sync item type

Follows `filter-handler.ts`, the simplest record type. Per the `adding-sync-item-type` skill:

- `packages/contracts/src/sync-api.ts` — add `template` to **four** arrays: `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`. Omitting `ENCRYPTABLE_ITEM_TYPES` makes encryption refuse the type and sync silently drops it.
- `packages/contracts/src/sync-payloads.ts` — `TemplateSyncPayloadSchema`: `name`, `description`, `icon`, `tags`, `properties`, `content`, `clock`, `createdAt`, `modifiedAt`.
- `packages/db-schema/src/schema/templates.ts` — Drizzle table with `clock` JSON column. The data-DB migration is **hand-written** (Drizzle snapshots are broken past 0021).
- `sync/item-handlers/template-handler.ts` + registry entry, `sync/template-sync.ts`, `offline-clock.ts`, `local-mutations.ts`, `runtime.ts`, `manifest-check.ts`, and the `sync-telemetry.ts` `toSyncDomain` case (its switch is exhaustive — typecheck fails until added).
- `TemplatesChannels` already exists and is already emitted by `vault/templates.ts`; no new channel object needed.

### Part 3 — Templates move into the DB

- `BUILT_IN_TEMPLATES` stays a code constant, served directly by `listTemplates`/`getTemplate`. No rows, no files, never synced.
- Custom templates become rows in `templates`.
- `vault/templates.ts` CRUD is rewritten against the DB and **must call** the `local-mutations` `enqueueCreate/Update/Delete` on every mutation. Registering the adapter alone does nothing; mutations that bypass it seed once and then never sync again.
- Deletes `ensureTemplatesDir`, `seedBuiltInTemplates`, `parseTemplate`/`serializeTemplate` and all template file I/O. `parseTemplate` moves into the migration module before deletion — the migration still needs it.
- The IPC contract shape is unchanged, so the renderer is untouched. Run `pnpm ipc:generate && pnpm ipc:check` regardless.

### Part 4 — Migration for existing users

One-time, idempotent, guarded by a settings key, run on vault open:

1. If `.memry/templates/` exists, read each `*.md` and parse it.
2. Skip any with `isBuiltIn: true`.
3. Insert each custom template as a row, **using the id from its frontmatter** (falling back to the filename basename, matching today's `parseTemplate`), with `clock = NULL`.
4. `seedUnclocked` then increments the clock, enqueues a `create`, and pushes.
5. **Old files are left on disk untouched** — zero-risk, and it doubles as the downgrade path.

Convergence: two devices with independent template sets produce the union on both (ids are random per device, so no collisions). A vault copied between devices yields the same id on both; both push, and LWW converges.

## Backward compatibility

Backward compatibility is mandatory — this is a live beta with real users on macOS, Windows and Linux.

- **Old clients:** send no `X-Memry-Sync-Types` header → server serves the frozen legacy list → they never see templates.
- **Deploy order:** server to prod first, desktop release trails it.
- **Downgrade:** an older build still finds `.memry/templates/*.md` on disk and reads its pre-migration templates. Degraded (no sync, no post-migration edits) but not broken, and no data is destroyed.
- **No DB resets.** The `templates` table is additive and hand-written.

## Testing

**Handler unit tests** (`template-handler.test.ts`, modelled on `task-handler.test.ts`): insert; newer-clock update; older-clock skip; concurrent → `'conflict'`; delete; delete-skip; `seedUnclocked` enqueues; built-in never enqueued.

**Migration tests:** imports custom templates from legacy files; idempotent across repeated runs; id preserved from frontmatter; built-ins skipped; missing `.memry/templates/` is a no-op.

**Server tests:** `getChanges`/`getManifest`/`pullItems` bind only the negotiated types; a header-less request is served the frozen legacy list (the regression that protects shipped binaries); an unknown type in the header is dropped rather than bound; `pullItems`' `BATCH_SIZE` stays correct as the negotiated list length varies.

**E2E** (`templates-sync.e2e.ts`) on the existing dual-device harness — `fixtures/sync-auth-fixtures` (`electronAppA/B`, `pageA/pageB`, `bootstrappedSyncPair`) with `utils/network-control` (`goOffline`/`goOnline`/`syncBothAndWait`), modelled on `body-crdt-create-propagation.e2e.ts`:

1. Create custom template on A → appears on B.
2. Edit on A → propagates to B.
3. Delete on A → tombstoned on B.
4. Both devices edit offline → LWW converges, no sync loop.
5. Legacy `.memry/templates/*.md` pre-seeded on A → migrated and synced to B.
6. Built-ins present and identical on both, never duplicated.

## Risks

| Risk                                       | Mitigation                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Header-less request served new types       | The one regression that matters: absent header MUST resolve to the frozen legacy list. Dedicated server test. |
| `ENCRYPTABLE_ITEM_TYPES` omitted           | Sync silently drops the type — explicit checklist item + handler test.                                        |
| Mutations bypass `local-mutations` enqueue | Templates seed once then never sync — asserted in tests.                                                      |
| Desktop ships before server                | Old clients break. Deploy order is a hard rule in both plans.                                                 |
| Drizzle migration assumed automatic        | False. Hand-written SQL under `apps/desktop/src/main/database/drizzle-data/`.                                 |

## Plan split

- **Plan A — sync-type capability negotiation.** Server-first, standalone, independently valuable: it is the root fix for `d6-d8.md:1873` and unblocks the mobile program's three new types.
- **Plan B — template sync type + DB move + migration.** Gated on Plan A being deployed to production.

Both target the next release. Plan A can merge and deploy independently.

## Follow-up (out of scope)

`docs/superpowers/plans/2026-07-14-server-desktop-additive-d6-d8.md:1873` should be corrected once Plan A lands, and its backward-compat section rewritten to reference the negotiation mechanism.
