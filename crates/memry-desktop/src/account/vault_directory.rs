//! The account's vault directory, ported from Electron's `sync/vault-directory.ts`: the account
//! vault list for the switcher, cached in `memry-config.json` `sync.accountVaultsCache` for
//! offline use, the registration of every local vault this account syncs, the icon each vault
//! carries account-wide, deleting a vault from the account, and making the folder of a vault
//! only the account holds.
//!
//! [`AccountService::refresh_vault_directory`] holds `directory` for its whole pass, so two
//! refreshes never interleave and one that waited behind another sees its throttle stamp. A
//! delete holds it too, so a refresh never registers a vault the delete removes. A refresh that
//! a sign-out overtakes caches nothing: the next account never sees this one's vault names.

use std::path::{Path, PathBuf};

use memry_core::api::crypto::{decrypt_vault_icon, decrypt_vault_name, encrypt_vault_icon};
use memry_core::protocol::account::{VaultDirectoryRow, VaultSummary};
use memry_core::seams::secure_store::SecureStoreKey;
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use super::linking::is_vault_id;
use super::{AccountError, AccountService};
use crate::registry::{VaultRegistry, vault_icon};
use crate::session::Session;

/// `REFRESH_THROTTLE_MS`: a refresh that is not forced runs at most this often.
pub const REFRESH_THROTTLE: std::time::Duration = std::time::Duration::from_secs(30);

const CACHE_KEY: &str = "accountVaultsCache";

/// One vault of the account as the switcher shows it (`AccountVaultInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountVaultInfo {
    pub vault_uuid: String,
    /// Decrypted; `None` when absent or undecryptable.
    pub name: Option<String>,
    pub item_count: i64,
    pub created_at: Option<i64>,
    /// The local copy's folder; `None` for a vault only the account holds.
    pub local_path: Option<String>,
    /// Where a download would create the vault.
    pub suggested_path: String,
}

/// The folder [`AccountService::prepare_vault_download`] leaves for the caller to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadTarget {
    /// A registered vault already carries the id: it opens instead of a second download.
    Existing(PathBuf),
    /// A new folder, made into a vault bound to the id and registered.
    Provisioned(PathBuf),
}

/// A cached row of `sync.accountVaultsCache.vaults`, Electron's `{vaultUuid, name, itemCount,
/// createdAt}`.
struct CachedVault {
    vault_uuid: String,
    name: Option<String>,
    item_count: i64,
    created_at: Option<i64>,
}

impl AccountService {
    /// `refreshVaultDirectory`: reads the account's vaults, caches them with their names, and
    /// registers each local vault this account syncs that the server lacks or knows by another
    /// name, then reconciles its icon. Signed out, without the master key, or within
    /// [`REFRESH_THROTTLE`] of the last read (unless `force`), it does nothing; after a sign-out
    /// that overtook it, it stops before the cache. Failures are
    /// logged and retried on the next refresh. Returns whether a vault's icon changed here, for
    /// the caller's `VaultListChangedEvent`.
    pub async fn refresh_vault_directory(&self, registry: &VaultRegistry, force: bool) -> bool {
        let mut last = self.directory.lock().await;
        if !force && last.is_some_and(|at| at.elapsed() < REFRESH_THROTTLE) {
            return false;
        }
        let Some(epoch) = self.signed_in_epoch() else {
            return false;
        };
        if !matches!(self.session.valid_access_token().await, Ok(Some(_))) {
            return false;
        }
        let master = match self.store.get(SecureStoreKey::MasterKey) {
            Ok(Some(master)) => Zeroizing::new(master),
            Ok(None) => return false,
            Err(error) => {
                tracing::warn!(
                    scope = "VaultDirectory",
                    "the master key is unavailable: {error}"
                );
                return false;
            }
        };
        let rows = match self.session.vault_directory().await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(
                    scope = "VaultDirectory",
                    "vault directory refresh failed: {error}"
                );
                return false;
            }
        };
        *last = Some(tokio::time::Instant::now());

        let remote: Vec<CachedVault> = rows.iter().map(|row| cached(&master, row)).collect();
        match self.epoch.write_if(epoch, || {
            self.write_sync(|sync| {
                sync.insert(CACHE_KEY.into(), cache_json(&remote));
            })
        }) {
            None => return false,
            Some(Err(error)) => tracing::warn!(
                scope = "VaultDirectory",
                "the vault list was not cached: {error}"
            ),
            Some(Ok(())) => {}
        }

        let Some(user_id) = self.session.account_user_id() else {
            return false;
        };
        let mut icons_changed = false;
        for local in registry.stored() {
            // A sign-out since the list arrived: nothing more goes to the server for this account.
            if self.epoch.current() != epoch {
                break;
            }
            let Some(uuid) = local.vault_uuid.as_deref() else {
                continue;
            };
            // Only vaults this account syncs: the registry also lists another account's vaults
            // left behind by a sign-out, and registering those would hand their names and a
            // vault slot to whoever signed in next (`vault-directory.ts:105-110`).
            if !local
                .account_binding
                .as_ref()
                .is_some_and(|b| b.mode == "sync" && b.user_id == user_id)
            {
                continue;
            }
            let known = remote.iter().find(|v| v.vault_uuid == uuid);
            if known.is_none_or(|v| v.name.as_deref() != Some(local.name.as_str()))
                && let Err(error) = self
                    .session
                    .register_vault(uuid.to_owned(), local.name.clone())
                    .await
            {
                // A 402 (no plan, or the vault limit) is expected: registration retries on the
                // next refresh once the entitlement changes.
                tracing::info!(
                    scope = "VaultDirectory",
                    "vault self-registration skipped: {error}"
                );
            }
            let server = rows.iter().map(|r| &r.summary).find(|s| s.id == uuid);
            if self
                .sync_vault_icon(Path::new(&local.path), uuid, server, &master)
                .await
            {
                icons_changed = true;
            }
        }
        icons_changed
    }

    /// `syncVaultIcon`: last writer wins on the change time. A local change the account lacks is
    /// pushed; a newer account copy is adopted. Returns whether the local icon changed. A failed
    /// push keeps the change pending for the next refresh.
    async fn sync_vault_icon(
        &self,
        vault: &Path,
        uuid: &str,
        server: Option<&VaultSummary>,
        master: &[u8],
    ) -> bool {
        if !vault.is_dir() {
            return false;
        }
        let local = vault_icon::read(vault);
        let remote_at = server.and_then(|s| s.icon_updated_at);

        if let Some(local) = local.as_ref().filter(|l| l.pending_sync)
            && remote_at.is_none_or(|at| local.updated_at > at)
        {
            let sealed = match local
                .value
                .as_deref()
                .map(|v| encrypt_vault_icon(master, uuid, v))
            {
                Some(Ok(sealed)) => Some(sealed),
                None => None,
                Some(Err(error)) => {
                    tracing::warn!(scope = "VaultDirectory", "vault icon not sealed: {error}");
                    return false;
                }
            };
            if let Err(error) = self
                .session
                .set_vault_icon(uuid, sealed.as_ref(), local.updated_at)
                .await
            {
                // 402, 404 (not registered yet, or a server without icons), offline.
                tracing::info!(scope = "VaultDirectory", "vault icon push skipped: {error}");
                return false;
            }
            // A refused stale write (`applied: false`) is adopted on the next refresh.
            if let Err(error) = vault_icon::clear_pending(vault, local.updated_at) {
                tracing::warn!(
                    scope = "VaultDirectory",
                    "vault icon not marked synced: {error}"
                );
            }
            return false;
        }

        if let Some(remote_at) = remote_at
            && remote_at > local.as_ref().map_or(-1, |l| l.updated_at)
        {
            let value = match server
                .and_then(|s| s.encrypted_icon.as_deref().zip(s.icon_nonce.as_deref()))
            {
                // Undecryptable, or a format this build cannot draw: keep the local icon.
                Some((sealed, nonce)) => match decrypt_vault_icon(master, uuid, sealed, nonce) {
                    Some(value) if vault_icon::is_valid(&value) => Some(value),
                    _ => return false,
                },
                None => None,
            };
            return match vault_icon::adopt(vault, value.as_deref(), remote_at) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(
                        scope = "VaultDirectory",
                        "account vault icon not stored: {error}"
                    );
                    false
                }
            };
        }

        // The same change time on both sides: the account already has this change.
        if let Some(local) = local.filter(|l| l.pending_sync)
            && let Err(error) = vault_icon::clear_pending(vault, local.updated_at)
        {
            tracing::warn!(
                scope = "VaultDirectory",
                "vault icon not marked synced: {error}"
            );
        }
        false
    }

    /// `listAccountVaults`: the cached account list, each vault with its local copy's folder
    /// (matched by id) and a download folder under `parent`. Reads no network, so the switcher
    /// shows the last list offline.
    pub fn list_account_vaults(
        &self,
        registry: &VaultRegistry,
        parent: &Path,
    ) -> Vec<AccountVaultInfo> {
        let local = registry.stored();
        self.cached_vaults()
            .into_iter()
            .map(|v| AccountVaultInfo {
                local_path: local
                    .iter()
                    .find(|l| l.vault_uuid.as_deref() == Some(v.vault_uuid.as_str()))
                    .map(|l| l.path.clone()),
                suggested_path: suggest_vault_folder(&v.vault_uuid, v.name.as_deref(), parent)
                    .to_string_lossy()
                    .into_owned(),
                vault_uuid: v.vault_uuid,
                name: v.name,
                item_count: v.item_count,
                created_at: v.created_at,
            })
            .collect()
    }

    fn cached_vaults(&self) -> Vec<CachedVault> {
        self.config.read(|config| {
            config
                .get("sync")
                .and_then(|sync| sync.get(CACHE_KEY))
                .and_then(|cache| cache.get("vaults"))
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(from_cache).collect::<Vec<_>>())
                .unwrap_or_default()
        })
    }

    /// The folder half of `downloadRemoteVault` (`vault-directory.ts:266-318`): the registered
    /// copy of `vault_uuid` when there is one, else a new folder under `parent`, named after the
    /// cached name ([`suggest_vault_folder`]), made into a vault bound to `vault_uuid` and
    /// registered under it ([`Session::provision_dormant`]). The open vault stays open; the
    /// caller switches to the folder. Blocking.
    pub fn prepare_vault_download(
        &self,
        session: &Session,
        vault_uuid: &str,
        parent: &Path,
    ) -> Result<DownloadTarget, AccountError> {
        if !is_vault_id(vault_uuid) {
            return Err(AccountError::InvalidVaultId);
        }
        if let Some(local) = session
            .registry()
            .stored()
            .into_iter()
            .find(|v| v.vault_uuid.as_deref() == Some(vault_uuid))
        {
            return Ok(DownloadTarget::Existing(PathBuf::from(local.path)));
        }
        let name = self
            .cached_vaults()
            .into_iter()
            .find(|v| v.vault_uuid == vault_uuid)
            .and_then(|v| v.name);
        let folder = suggest_vault_folder(vault_uuid, name.as_deref(), parent);
        session
            .provision_dormant(&folder, vault_uuid)
            .map_err(|e| AccountError::VaultDownload(e.to_string()))?;
        tracing::info!(
            scope = "VaultDirectory",
            "account vault provisioned for download"
        );
        Ok(DownloadTarget::Provisioned(folder))
    }

    /// `deleteAccountVault`: removes the vault from the account and forgets its local entry, so
    /// the next refresh cannot register it again. Never touches files. Refuses the open vault.
    /// Waits for a refresh in flight, which could otherwise register the vault after the delete.
    pub async fn delete_account_vault(
        &self,
        session: &Session,
        vault_uuid: &str,
    ) -> Result<(), AccountError> {
        let _directory = self.directory.lock().await;
        let local = session
            .registry()
            .stored()
            .into_iter()
            .find(|v| v.vault_uuid.as_deref() == Some(vault_uuid));
        let open = session.current().map(|open| open.path);
        if let (Some(local), Some(open)) = (&local, open)
            && Path::new(&local.path) == open
        {
            return Err(AccountError::DeleteOpenVault);
        }
        if !matches!(self.session.valid_access_token().await, Ok(Some(_))) {
            return Err(AccountError::DeleteSignedOut);
        }
        self.session.delete_vault(vault_uuid.to_owned()).await?;
        if let Some(local) = &local {
            session
                .remove(&local.path)
                .map_err(|e| AccountError::VaultList(e.to_string()))?;
        }
        tracing::info!(
            scope = "VaultDirectory",
            had_local_copy = local.is_some(),
            "vault deleted from account"
        );
        Ok(())
    }
}

/// `suggestVaultFolder`: `<parent>/<slug of the name>`, else `memry-vault-<first 8 of the id>`,
/// with `-2`, `-3`, ... until the folder does not exist.
pub fn suggest_vault_folder(vault_uuid: &str, name: Option<&str>, parent: &Path) -> PathBuf {
    let slug = name.map(slugify).unwrap_or_default();
    let base = if slug.is_empty() {
        format!(
            "memry-vault-{}",
            vault_uuid.chars().take(8).collect::<String>()
        )
    } else {
        slug
    };
    let mut candidate = parent.join(&base);
    let mut suffix = 2;
    while candidate.exists() {
        candidate = parent.join(format!("{base}-{suffix}"));
        suffix += 1;
    }
    candidate
}

/// Lowercased, each run outside `[a-z0-9-_]` turned into `-`, and `-` trimmed from both ends.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out.trim_matches('-').to_owned()
}

fn cached(master: &[u8], row: &VaultDirectoryRow) -> CachedVault {
    let summary = &row.summary;
    CachedVault {
        name: summary
            .encrypted_name
            .clone()
            .zip(summary.name_nonce.clone())
            .and_then(|(sealed, nonce)| {
                decrypt_vault_name(master.to_vec(), summary.id.clone(), sealed, nonce)
            }),
        vault_uuid: summary.id.clone(),
        item_count: row.item_count,
        created_at: row.created_at,
    }
}

fn cache_json(vaults: &[CachedVault]) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    json!({
        "fetchedAt": now_ms,
        "vaults": vaults.iter().map(|v| json!({
            "vaultUuid": v.vault_uuid,
            "name": v.name,
            "itemCount": v.item_count,
            "createdAt": v.created_at,
        })).collect::<Vec<_>>(),
    })
}

/// A cached row another build wrote; one without an id is skipped.
fn from_cache(row: &Value) -> Option<CachedVault> {
    let row: &Map<String, Value> = row.as_object()?;
    Some(CachedVault {
        vault_uuid: row.get("vaultUuid")?.as_str()?.to_owned(),
        name: row.get("name").and_then(Value::as_str).map(str::to_owned),
        item_count: row.get("itemCount").and_then(Value::as_i64).unwrap_or(0),
        created_at: row.get("createdAt").and_then(Value::as_i64),
    })
}
