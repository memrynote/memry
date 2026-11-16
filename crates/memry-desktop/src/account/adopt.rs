//! `adoptAccountVaultIfAbsent` (`sync/vault-adoption.ts:99-129`, #2226): right after a sign-in
//! registers this device, an open vault with nothing in it joins the account's vault instead of
//! becoming a new one. Registration does not spend a vault slot, so this is the last moment the
//! open vault's identity can still change before its first push.

use super::binding::{folder_has_files, local_vault_uuid};
use super::{AccountError, AccountService};
use crate::session::OpenVault;

impl AccountService {
    /// Binds the open vault to the account's first vault (the server lists them by item count)
    /// when the vault is empty, not bound to a server vault yet, and unknown to the account.
    /// Returns the adopted id; `None` changes nothing. A list that cannot be read adopts nothing,
    /// as Electron does.
    pub async fn adopt_account_vault_if_absent(
        &self,
        open: &OpenVault,
    ) -> Result<Option<String>, AccountError> {
        let vault = open.vault.clone();
        let path = open.path.clone();
        let (bound, has_content) = tokio::task::spawn_blocking(move || {
            let bound = vault
                .server_vault_id()
                .map(|id| id.is_some())
                .unwrap_or(true);
            (
                bound,
                vault.has_local_rows().unwrap_or(true) || folder_has_files(&path),
            )
        })
        .await
        .unwrap_or((true, true));
        if bound || has_content {
            return Ok(None);
        }
        let vaults = match self.session.vaults().await {
            Ok(vaults) => vaults,
            Err(error) => {
                tracing::warn!(
                    scope = "Binding",
                    "could not list account vaults after registration: {error}"
                );
                return Ok(None);
            }
        };
        let local = local_vault_uuid(&open.vault)?;
        let Some(target) = vaults.first().map(|v| v.id.clone()) else {
            return Ok(None);
        };
        if vaults.iter().any(|v| v.id == local) {
            return Ok(None);
        }
        let vault = open.vault.clone();
        let id = target.clone();
        tokio::task::spawn_blocking(move || vault.bind_server_vault(&id))
            .await
            .map_err(|e| AccountError::VaultChoice(e.to_string()))?
            .map_err(|e| AccountError::VaultChoice(e.to_string()))?;
        tracing::info!(
            scope = "Binding",
            count = vaults.len(),
            "adopted the account's vault instead of registering a new one"
        );
        Ok(Some(target))
    }
}
