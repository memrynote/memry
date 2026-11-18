//! Which account the open vault syncs with, ported from Electron's
//! `sync/vault-account-binding.ts` and `sync/vault-binding-resolve.ts`.
//!
//! Sign-out keeps every vault on disk. The binding (`{userId, mode}`, core `meta` key
//! `sync.account-binding.v1`, mirrored in the registry entry's `accountBinding`) records whose a
//! vault is, so the next account to sign in never syncs another account's notes. [`decide`] is
//! the pure rule; [`AccountService::apply_open_vault_binding`] gathers its inputs, binds and tells
//! the sync gate.

use std::path::Path;

use memry_core::api::vault::Vault;
use serde::{Deserialize, Serialize};

use super::{AccountError, AccountService};
use crate::registry::VaultRegistry;
use crate::registry::vaults::AccountBinding;
use crate::session::OpenVault;
use crate::sync::gate::VaultBinding;

/// The stored binding (`VaultAccountBinding`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBinding {
    pub user_id: String,
    pub mode: BindingMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BindingMode {
    /// Syncs with `user_id`.
    Sync,
    /// `user_id` chose to keep it on this device.
    Local,
}

/// `VaultBindingState` (`ipc-sync-ops.ts:114`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingState {
    Bound,
    LocalOnly,
    Foreign,
    Unknown,
    NeedsDecision {
        account_vault_count: usize,
        merge_target: Option<MergeTarget>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeTarget {
    pub vault_uuid: String,
    pub name: Option<String>,
}

impl BindingState {
    /// What the sync gate holds on.
    pub fn gate(&self) -> VaultBinding {
        match self {
            Self::Bound => VaultBinding::Bound,
            Self::LocalOnly => VaultBinding::LocalOnly,
            Self::Foreign => VaultBinding::Foreign,
            Self::Unknown => VaultBinding::Unknown,
            Self::NeedsDecision { .. } => VaultBinding::NeedsDecision,
        }
    }
}

/// `VaultBindingChoice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingChoice {
    /// Add this vault to the account as its own vault.
    Sync,
    /// Join the account's existing vault (`mergeTarget`).
    Merge,
    /// Keep it on this device.
    Local,
}

/// One account vault as the binding sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountVault {
    pub vault_uuid: String,
    pub name: Option<String>,
}

/// `BindingInputs`.
#[derive(Debug, Clone)]
pub struct BindingInputs {
    pub binding: Option<StoredBinding>,
    pub user_id: String,
    pub local_vault_uuid: String,
    pub has_local_content: bool,
    /// Written by a device other than this one (another account's session).
    pub has_foreign_history: bool,
    /// `None`: the account's vault list could not be fetched.
    pub account_vaults: Option<Vec<AccountVault>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Start { bind: bool },
    Hold(BindingState),
}

/// `decideVaultBinding` (`vault-account-binding.ts:79-110`). Order matters: an empty vault has
/// nothing to leak, so it binds before any network check; the account knowing the uuid proves
/// ownership; history from another device on a vault the account does not know means another
/// account synced it.
pub fn decide(input: &BindingInputs) -> Decision {
    if let Some(binding) = &input.binding {
        if binding.user_id == input.user_id {
            return match binding.mode {
                BindingMode::Sync => Decision::Start { bind: false },
                BindingMode::Local => Decision::Hold(BindingState::LocalOnly),
            };
        }
        if binding.mode == BindingMode::Sync {
            return Decision::Hold(BindingState::Foreign);
        }
    }
    if !input.has_local_content {
        return Decision::Start { bind: true };
    }
    let Some(vaults) = &input.account_vaults else {
        return Decision::Hold(BindingState::Unknown);
    };
    if vaults
        .iter()
        .any(|v| v.vault_uuid == input.local_vault_uuid)
    {
        return Decision::Start { bind: true };
    }
    if input.has_foreign_history {
        return Decision::Hold(BindingState::Foreign);
    }
    // Electron sorts by `itemCount` descending; the vault list carries no count, so every
    // vault ties and the stable sort keeps the first.
    Decision::Hold(BindingState::NeedsDecision {
        account_vault_count: vaults.len(),
        merge_target: vaults.first().map(|v| MergeTarget {
            vault_uuid: v.vault_uuid.clone(),
            name: v.name.clone(),
        }),
    })
}

/// `isChoiceAllowed`: a foreign vault accepts nothing (recording `local` would replace the
/// owner's binding with ours).
pub fn is_choice_allowed(state: &BindingState, choice: BindingChoice) -> bool {
    match state {
        BindingState::NeedsDecision { merge_target, .. } => {
            choice != BindingChoice::Merge || merge_target.is_some()
        }
        BindingState::LocalOnly => choice == BindingChoice::Sync,
        _ => false,
    }
}

/// The stored binding, `None` for none or for JSON an older or newer build wrote that does not
/// parse (`readVaultAccountBinding`).
pub fn read_binding(vault: &Vault) -> Result<Option<StoredBinding>, AccountError> {
    let json = vault.account_binding().map_err(storage)?;
    Ok(json
        .and_then(|json| serde_json::from_str::<StoredBinding>(&json).ok())
        .filter(|b| !b.user_id.is_empty()))
}

/// Writes the binding into the vault and mirrors it onto the registry entry
/// (`writeVaultAccountBinding`), which the account vault directory reads for closed vaults.
/// `server_vault` is the id a sync binding binds to; the registry entry takes it in the same
/// write as the binding mirror, so no crash between two writes leaves a stale `vaultUuid`.
pub fn write_binding(
    open: &OpenVault,
    registry: &VaultRegistry,
    binding: &StoredBinding,
    server_vault: Option<&str>,
) -> Result<(), AccountError> {
    let json =
        serde_json::to_string(binding).map_err(|e| AccountError::VaultChoice(e.to_string()))?;
    open.vault.set_account_binding(&json).map_err(storage)?;
    let path = open.path.to_string_lossy();
    if let Some(mut stored) = registry.get(&path) {
        stored.account_binding = Some(AccountBinding {
            user_id: binding.user_id.clone(),
            mode: match binding.mode {
                BindingMode::Sync => "sync",
                BindingMode::Local => "local",
            }
            .to_owned(),
        });
        if let Some(id) = server_vault {
            stored.vault_uuid = Some(id.to_owned());
        }
        if let Err(error) = registry.upsert(&stored) {
            tracing::warn!(
                scope = "Binding",
                "the registry mirror was not written: {error}"
            );
        }
    }
    Ok(())
}

/// The id the server knows this vault by: the bound one, else the vault's own id, which
/// Electron sends as its `vaultUuid`.
pub fn local_vault_uuid(vault: &Vault) -> Result<String, AccountError> {
    Ok(vault
        .server_vault_id()
        .map_err(storage)?
        .unwrap_or_else(|| vault.id()))
}

fn storage(error: memry_core::api::errors::StorageError) -> AccountError {
    AccountError::VaultChoice(error.to_string())
}

const CONTENT_SCAN_MAX_DEPTH: usize = 6;
const CONTENT_SCAN_MAX_ENTRIES: usize = 5_000;

/// A file a user could lose or leak in the vault folder (`folderHasFiles`). Dot entries are app
/// state. Past the scan budget it answers yes: a false "empty" binds without asking.
pub fn folder_has_files(root: &Path) -> bool {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() {
                return true;
            }
            seen += 1;
            if seen > CONTENT_SCAN_MAX_ENTRIES {
                return true;
            }
            if kind.is_dir() && depth < CONTENT_SCAN_MAX_DEPTH {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    false
}

/// What [`AccountService::apply_open_vault_binding`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    Start,
    Held(BindingState),
}

impl AccountService {
    /// `applyOpenVaultBinding`: decide for the open vault, bind when that is the answer. The
    /// network is asked only for an unbound vault with content. Signed out holds as `Unknown`, and
    /// so does a sign-out that overtakes the server's answer: it binds nothing.
    pub async fn apply_open_vault_binding(
        &self,
        open: &OpenVault,
        registry: &VaultRegistry,
    ) -> Result<Applied, AccountError> {
        // Signed in, not merely holding tokens: a refused sign-out leaves them behind.
        let (Some(epoch), Some(user_id)) = (self.signed_in_epoch(), self.session.account_user_id())
        else {
            return Ok(Applied::Held(BindingState::Unknown));
        };
        let binding = read_binding(&open.vault)?;
        let ours = binding.as_ref().is_some_and(|b| b.user_id == user_id);
        let has_local_content = ours || {
            let vault = open.vault.clone();
            let path = open.path.clone();
            tokio::task::spawn_blocking(move || {
                vault.has_local_rows().unwrap_or(true) || folder_has_files(&path)
            })
            .await
            .unwrap_or(true)
        };
        let unbound = !ours && binding.as_ref().is_none_or(|b| b.mode != BindingMode::Sync);
        let needs_server = unbound && has_local_content;
        let has_foreign_history = needs_server && self.has_foreign_history(&open.vault)?;
        let account_vaults = if needs_server {
            self.account_vaults().await
        } else {
            Some(Vec::new())
        };
        let decision = decide(&BindingInputs {
            binding,
            user_id: user_id.clone(),
            local_vault_uuid: local_vault_uuid(&open.vault)?,
            has_local_content,
            has_foreign_history,
            account_vaults,
        });
        match decision {
            Decision::Hold(state) => Ok(Applied::Held(state)),
            Decision::Start { bind: false } => Ok(Applied::Start),
            Decision::Start { bind: true } => {
                match self
                    .epoch
                    .write_if(epoch, || self.bind_for_sync(open, registry, &user_id, None))
                {
                    Some(bound) => bound.map(|()| Applied::Start),
                    None => Ok(Applied::Held(BindingState::Unknown)),
                }
            }
        }
    }

    /// `resolveOpenVaultBinding`: the user's answer to the binding prompt. Returns the new state.
    pub fn resolve_open_vault_binding(
        &self,
        open: &OpenVault,
        registry: &VaultRegistry,
        state: &BindingState,
        choice: BindingChoice,
    ) -> Result<BindingState, AccountError> {
        if !is_choice_allowed(state, choice) {
            return Err(AccountError::VaultChoice(
                "This vault cannot change how it syncs right now".into(),
            ));
        }
        let Some(user_id) = self.session.account_user_id() else {
            return Err(AccountError::VaultChoice(
                "Sign in to sync this vault".into(),
            ));
        };
        match choice {
            BindingChoice::Local => {
                write_binding(
                    open,
                    registry,
                    &StoredBinding {
                        user_id,
                        mode: BindingMode::Local,
                    },
                    None,
                )?;
                Ok(BindingState::LocalOnly)
            }
            BindingChoice::Merge | BindingChoice::Sync => {
                let target = match (choice, state) {
                    (BindingChoice::Merge, BindingState::NeedsDecision { merge_target, .. }) => {
                        merge_target.as_ref().map(|t| t.vault_uuid.clone())
                    }
                    _ => None,
                };
                self.bind_for_sync(open, registry, &user_id, target.as_deref())?;
                Ok(BindingState::Bound)
            }
        }
    }

    /// `bindVaultForSync` (and `adoptVaultLocally` for a merge): the server vault id first, so a
    /// refused rebind (bound to another server vault) records no binding, then the binding.
    fn bind_for_sync(
        &self,
        open: &OpenVault,
        registry: &VaultRegistry,
        user_id: &str,
        server_vault: Option<&str>,
    ) -> Result<(), AccountError> {
        let id = match server_vault {
            Some(id) => id.to_owned(),
            None => local_vault_uuid(&open.vault)?,
        };
        open.vault.bind_server_vault(&id).map_err(storage)?;
        write_binding(
            open,
            registry,
            &StoredBinding {
                user_id: user_id.to_owned(),
                mode: BindingMode::Sync,
            },
            // The account vault directory registers the vault under this id (a merge changes
            // it, `vault-binding-resolve.ts:44-47`).
            Some(&id),
        )?;
        Ok(())
    }

    /// Ticks from a device other than this install's own: the id its writes stamp (from the
    /// device key) and the server id `sync.deviceId` records.
    fn has_foreign_history(&self, vault: &Vault) -> Result<bool, AccountError> {
        let mut own = Vec::new();
        if let Ok(local) = self.session.local_device_id() {
            own.push(local);
        }
        if let (_, Some(server), _) = self.sync_fields() {
            own.push(server);
        }
        vault.has_foreign_history(own).map_err(storage)
    }

    /// `fetchAccountVaults`: `None` when the list cannot be read.
    async fn account_vaults(&self) -> Option<Vec<AccountVault>> {
        match self.session.vaults().await {
            Ok(vaults) => Some(
                vaults
                    .into_iter()
                    .map(|v| AccountVault {
                        vault_uuid: v.id,
                        name: v.name,
                    })
                    .collect(),
            ),
            Err(error) => {
                tracing::warn!(scope = "Binding", "could not fetch account vaults: {error}");
                None
            }
        }
    }
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;
