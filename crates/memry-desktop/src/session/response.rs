//! What the vault commands hand the renderer: `VaultStatus` and `SelectVaultResponse` of
//! `packages/contracts/src/vault-api.ts`.

use serde::{Deserialize, Serialize};

use super::{CreateOrOpenError, SessionError, SessionStatus, VaultOpened};
use crate::registry::{StoredVault, VaultInfo};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub is_open: bool,
    pub path: Option<String>,
    pub is_indexing: bool,
    /// 0 to 100.
    pub index_progress: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_built: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_total: Option<u32>,
    pub error: Option<String>,
}

impl From<SessionStatus> for VaultStatus {
    /// Indexing is Step 13 (#3530)'s; until it reports, no vault is indexing.
    fn from(status: SessionStatus) -> Self {
        Self {
            is_open: status.is_open,
            path: status.path,
            is_indexing: false,
            index_progress: 0,
            index_built: None,
            index_total: None,
            error: status.error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectVaultResponse {
    pub success: bool,
    pub vault: Option<VaultInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `already-exists` or `invalid-name`; absent on success and on other failures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl SelectVaultResponse {
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            vault: None,
            error: Some(message.into()),
            error_code: None,
        }
    }

    /// The folder picker was cancelled.
    pub fn no_folder() -> Self {
        Self::failure("No folder selected")
    }
}

/// `createVaultInfo` of Electron: the registry entry, without the fields only `vault:get-all`
/// computes.
fn info_of(stored: StoredVault) -> VaultInfo {
    VaultInfo {
        path: stored.path,
        name: stored.name,
        note_count: stored.note_count,
        task_count: stored.task_count,
        last_opened: stored.last_opened,
        is_default: stored.is_default,
        vault_uuid: stored.vault_uuid,
        is_missing: None,
        accent_color: None,
        icon: None,
    }
}

/// The vocabulary of the renderer's `IndexRecoveredEvent.reason`: `missing` for a first open
/// (nothing was repaired, the notice stays quiet) and `corrupt` for every repair.
pub fn index_recovery_reason(core_reason: &str) -> &'static str {
    if core_reason == memry_core::storage::index_db::MISSING_REASON {
        "missing"
    } else {
        "corrupt"
    }
}

pub fn open_response(outcome: Result<VaultOpened, SessionError>) -> SelectVaultResponse {
    match outcome {
        Ok(opened) => {
            let vault = opened.stored.map(info_of).or_else(|| {
                // The registry write failed (logged); the vault is open all the same.
                Some(VaultInfo {
                    path: opened.vault.path.to_string_lossy().into_owned(),
                    name: opened.vault.name.clone(),
                    note_count: 0,
                    task_count: 0,
                    last_opened: String::new(),
                    is_default: false,
                    vault_uuid: None,
                    is_missing: None,
                    accent_color: None,
                    icon: None,
                })
            });
            SelectVaultResponse {
                success: true,
                vault,
                error: None,
                error_code: None,
            }
        }
        Err(error) => SelectVaultResponse::failure(error.to_string()),
    }
}

pub fn create_response(outcome: Result<VaultOpened, CreateOrOpenError>) -> SelectVaultResponse {
    match outcome {
        Ok(opened) => open_response(Ok(opened)),
        Err(CreateOrOpenError::Create(error)) => SelectVaultResponse {
            error_code: error.code().map(str::to_owned),
            ..SelectVaultResponse::failure(error.to_string())
        },
        Err(CreateOrOpenError::Open(error)) => open_response(Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::fixture::*;

    #[test]
    fn a_taken_name_answers_already_exists_and_a_bad_one_invalid_name() {
        let f = fixture();
        let parent = f.vault("parent");
        std::fs::create_dir(parent.join("Taken")).expect("taken");
        let taken = create_response(f.session.create(&parent, "Taken"));
        assert!(!taken.success && taken.vault.is_none());
        assert_eq!(taken.error_code.as_deref(), Some("already-exists"));
        let bad = create_response(f.session.create(&parent, ".hidden"));
        assert_eq!(bad.error_code.as_deref(), Some("invalid-name"));
        let ok = create_response(f.session.create(&parent, "Fresh"));
        assert!(ok.success && ok.error_code.is_none());
        assert_eq!(ok.vault.expect("vault").name, "Fresh");
    }

    #[test]
    fn a_new_vault_reports_its_index_as_missing_and_a_damaged_one_as_corrupt() {
        let f = fixture();
        let vault = f.vault("v");
        let rx = f.session.subscribe();
        f.session.open(&vault, OpenSource::Select).expect("open");
        let reasons = |events: Vec<SessionEvent>| -> Vec<&'static str> {
            events
                .into_iter()
                .filter_map(|e| match e {
                    SessionEvent::IndexRecovered { reason } => Some(index_recovery_reason(&reason)),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(reasons(drain(&rx)), vec!["missing"]);
        f.session.close();
        let index = vault.join(".memry/core/index.db");
        let mut bytes = std::fs::read(&index).expect("read");
        bytes[..64].copy_from_slice(&[0xAB; 64]);
        std::fs::write(&index, bytes).expect("damage");
        f.session.open(&vault, OpenSource::Select).expect("reopen");
        assert_eq!(reasons(drain(&rx)), vec!["corrupt"]);
    }

    #[test]
    fn a_failed_switch_reads_as_the_electron_message() {
        let response = open_response(Err(SessionError::SwitchInProgress));
        assert_eq!(
            response.error.as_deref(),
            Some("A vault switch is already in progress")
        );
        assert!(!response.success);
    }
}
