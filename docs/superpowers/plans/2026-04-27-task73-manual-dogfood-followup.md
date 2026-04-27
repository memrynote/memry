# Task 73 Manual Dogfood Follow-up

Source checklist:
`docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`

Run mode:

- Fresh vault
- `VITE_MOCK_IPC=false`
- Debug Tauri bundle, not `/Applications/Memry.app`

Last attempted pass:

- Date: 2026-04-27
- Device: `task73-full-cu-20260427-1777302562366`
- Vault: `/tmp/task73-full-cu-20260427-1777302562366-vault`
- App data: `/Users/h4yfans/Library/Application Support/com.memry.memry/memry-task73-full-cu-20260427-1777302562366`

## Confirmed

- [x] Create note, type 500+ chars, restart, content remains.
  - `notes/beta-note.md` stayed on disk after restart.
  - File size was over 500 chars.
  - `note_metadata` had `Beta Note`, `notes/beta-note.md`, and updated `file_size`.

- [x] Rename note.
  - UI-created notes persisted as `notes/alpha-note.md` and `notes/beta-note.md`.

- [x] Wiki-link resolves enough to produce backlink.
  - `Alpha Note` linked `[[Beta Note]]`.
  - `Beta Note` showed a backlinks section with one link from `Alpha Note`.

- [x] Local-only toggle persisted.
  - UI showed `Note set to local only`.
  - `note_metadata.local_only = 1`.
  - `note_metadata.sync_policy = local-only`.
  - Local-only count query returned `1`.

## Still Need Manual Check

- [ ] Move note into folder.
  - Computer Use tree drag did not move the file.
  - Files stayed under `notes/`.
  - `note_positions` stayed empty.

- [ ] Reorder within folder.
  - Not confirmed because folder move did not succeed.

- [ ] Delete note and verify Task 27 trash behavior.
  - Not run yet. Deleting local data needs action-time confirmation.
  - Expected behavior: note disappears from active list and vault file moves to `.trash/<id>.md`.

- [ ] Wiki-link hover preview.
  - Backlink resolution worked, but hover preview was not exercised.

- [ ] File note metadata opens and reveal-in-Finder works.
  - Not exercised with a file note.

- [ ] Property create/update/options/status flows in folder view.
  - Attempted property create from the note UI failed.
  - UI showed `Failed to add property`.
  - `property_definitions` remained empty.
  - This likely needs a real implementation check around `properties_*` IPC routing.

- [ ] Attachment upload/list/delete deferred M6 shape without data loss.
  - Not confirmed from production-mode UI.
  - Mock stubs return `attachments-deferred-m6`, but with `VITE_MOCK_IPC=false` these are not real commands.

- [ ] Export/import/version deferred M8 shape and production guard.
  - Not confirmed from production-mode UI.
  - Mock stubs return `export-deferred-m8` / `versions-deferred-m8`, but with `VITE_MOCK_IPC=false` these route to Rust and are not in the real command set.

## Do Not Forget

Do not mark Task 73 complete in the source plan until every unchecked item above
has a fresh manual pass with UI evidence and disk/DB evidence where applicable.
