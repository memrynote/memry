# Account Vault Directory — Design

**Date:** 2026-06-09
**Status:** Approved (design); implementation pending

## Problem

Paid users sync per-vault (`vault_uuid` / `X-Memry-Vault-Id`), but the app has no unified story for:

1. Sign-in on a device when the account already has remote vaults.
2. Creating new vaults while signed in.
3. Discovering, on other devices, a vault created + synced elsewhere.

QR linking partially solves this (vault transfer + dormant provisioning), but eagerly provisions a folder for every account vault, and plain sign-in has no equivalent path.

## Decisions

- **Sync scope:** auto-sync all vaults for a signed-in paid user. No per-vault opt-in/opt-out.
- **Key delivery:** sign-in (email + password) derives the account master key (Argon2id), so any signed-in device can decrypt any vault. QR linking is a convenience path, not a key requirement. All three cases are discovery/UX/provisioning problems, not crypto problems.
- **Discovery:** poll + on-demand. Refetch `GET /sync/vaults` during fullSync (startup/reconnect) and when the vault switcher opens. No WebSocket event (can be added later as a fast path).
- **Download UX:** cloud-only vaults appear in the vault switcher under an "In your account" section. Clicking one opens a confirm dialog showing the destination path (default vaults dir + slugified name, changeable via folder picker); confirming provisions, switches, and pulls. No silent auto-download of folders.
- **Vault names:** server stores an `encrypted_name` blob per vault (encrypted client-side with the account master key). Server stays E2E-blind; devices decrypt for display.

## Architecture

One new main-process service — the **vault directory** — owns "what vaults exist in this account." Every flow (sign-in, linking, vault create, switcher) is a thin consumer of the same refresh/provision primitives.

### 1. Server (D1 + routes)

New `vaults` table:

| column | notes |
|---|---|
| `vault_uuid` | PK |
| `user_id` | FK, all queries scoped to auth user |
| `encrypted_name` | client-encrypted blob |
| `name_nonce` | nonce for the blob |
| `created_at`, `updated_at` | |

Routes (existing `authMiddleware`):

- `POST /sync/vaults` — idempotent upsert `{vaultUuid, encryptedName, nameNonce}`.
- `GET /sync/vaults` — reads the table, LEFT JOIN item counts (existing count logic). A freshly registered empty vault is therefore visible to other devices before its first item syncs.
- `PATCH /sync/vaults/:uuid` — rename blob; wired only if/where a local vault-rename feature exists.

Name encryption: XChaCha20-Poly1305 with the account master key, AAD `vault-name-v1:<uuid>`.

Pre-production: no migration/backfill. Clients self-heal missing rows (see refresh below).

### 2. Contracts + IPC

- New channels:
  - `vault.listAccount` → `AccountVaultInfo[]`: `{ vaultUuid, name: string | null, itemCount, createdAt, localPath: string | null }` (name decrypted in main).
  - `vault.downloadRemote(vaultUuid, parentPath?)` → `SelectVaultResponse`.
- `VaultInfo` gains optional `vaultUuid`, persisted into the global store at provision/open time, so local↔remote matching never requires opening a non-current vault's data.db.
- Run `pnpm ipc:generate` + `pnpm ipc:check` after contract edits.

### 3. Main process — `vault-directory.ts`

App-global cache (in-memory + store, with `fetchedAt`).

**`refresh()`**
1. Fetch `GET /sync/vaults` with the access token.
2. Decrypt names with the master key (failure → `name: null`, never blocks).
3. Merge with the local vault registry by `vaultUuid`.
4. **Self-registration diff:** any local vault uuid missing from the server list → `POST /sync/vaults` with its encrypted name. This single mechanism covers case 1 (pre-existing local vaults register on sign-in) and case 2 (new vault while signed in). The vault CREATE handler also triggers a refresh so registration is immediate, not deferred to the next sync.

**Triggers:** sign-in success, linking finalize, fullSync run, `listAccount` IPC call (throttled ~30s).

**`downloadRemote(uuid, parentPath?)`**
1. Resolve folder under the default vaults dir; name from decrypted vault name (slugified, deduped), fallback `memry-vault-<uuid8>`.
2. Existing `createDormantVault(folderPath, uuid)`.
3. `selectVault` switch → lazy sync pulls on open.
4. Idempotent on retry: re-running adopts the same uuid into the same folder.

**Linking change:** drop the create-many eager provisioning of every transferred vault. Linking keeps key transfer + the picker for choosing the *primary* vault; the remaining account vaults simply appear in the directory and download on demand.

### 4. Renderer — vault switcher

"In your account" section below local vaults, rendered only when authenticated and at least one remote-only vault exists:

- Cloud icon + decrypted name, fallback label `Vault · N items`.
- Click → download confirm dialog: vault name, item count, destination path prefilled (default vaults dir + slugified name) with a "Change…" button reusing the linking `pickVaultFolder` IPC. Confirm → `downloadRemote` with in-dialog progress → app switches to the new vault. Cancel → nothing created.
- i18n keys for all strings; Tailwind logical properties (`ms-*`/`me-*` etc.); errors via `extractErrorMessage` toast.

### 5. Error handling

- Offline / unauthenticated: serve cached directory list; hide the section when empty or signed out.
- Name decrypt failure: fallback label only.
- Download failure: toast; a half-provisioned folder may remain, retry re-adopts the same uuid (no cleanup pass needed).

### 6. Testing

- Server route tests: upsert/list/rename, cross-user isolation.
- `vault-directory` unit tests: merge, self-registration diff, decrypt fallback, throttling.
- `downloadRemote` test: provision + switch.
- Switcher renderer tests: section visibility rules, click → download flow, fallback labels.
- Two-device E2E: create vault on device A → appears in device B's switcher → download → assert adoption (uuid + registry), not decrypted content (bootstrap-key harness limitation).

## Out of scope

- WebSocket `vault_created` push (future fast path on top of polling).
- Per-vault sync opt-out.
- Vault rename propagation beyond wiring `PATCH` where a rename feature already exists.
- Remote vault deletion / detach from account.
