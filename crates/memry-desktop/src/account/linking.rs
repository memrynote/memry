//! Device linking (`sync/linking-service.ts`): this desktop as the approver that shows the code,
//! and as the new device that scans one. Chapter 03's payloads, MACs and keys live in core
//! (`DeviceApprover`, `DeviceLink`); this file holds what Electron kept beside them: which session
//! is pending, the vault choice, and the order of the new device's finalize.
//!
//! The new device's master key never reaches the keychain before the device is registered and the
//! key is proven to be the account's: core's `DeviceLink` writes it into [`HeldKey`], an in-memory
//! store, and [`AccountService::finalize_link`] writes it to the keychain last, as Electron's
//! `persistKeysAndRegisterDevice` does (`device-registration.ts:115-205`).

use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{ApiError, SecureStoreError};
use memry_core::api::linking::{DeviceLink, LinkingPoll};
use memry_core::api::linking_approver::{ApproverStatus, DeviceApprover};
use memry_core::api::vault::Vault;
use memry_core::crypto::keys;
use memry_core::protocol::linking::LinkingError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

use super::recovery::setup_expired;
use super::{AccountError, AccountService};
use crate::session::Session;

/// The approver's code, as the QR screen shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkingQr {
    pub qr_data: String,
    pub session_id: String,
    /// Epoch seconds.
    pub expires_at: i64,
}

/// A scanned code: the new device's half of the comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkScanned {
    pub session_id: String,
    pub verification_code: String,
}

/// One poll of `POST /auth/linking/complete` (`completeLinkingQr`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPoll {
    /// Not approved yet (`409`), or the poll was refused for the rate limit: poll again.
    Waiting,
    RateLimited,
    /// Approved. The finalize runs in the background and reports through the callback, unless
    /// the account has two or more vaults: then `vaults` lists them and
    /// [`AccountService::finalize_vault_choice`] finishes after the user picks.
    Linked {
        vaults: Option<Vec<String>>,
    },
}

/// `finalizeVaultChoice`'s input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultChoice {
    pub session_id: String,
    pub parent_folder: String,
    pub selected: Vec<String>,
    pub primary: String,
}

/// The master key `DeviceLink` opened, held in memory until the finalize writes it. Every other
/// key is refused: the link writes the master key and nothing else.
#[derive(Default)]
struct HeldKey(Mutex<Option<Zeroizing<Vec<u8>>>>);

impl HeldKey {
    fn take(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

impl SecureStore for HeldKey {
    fn get(&self, _key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(None)
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        if key != SecureStoreKey::MasterKey {
            return Err(SecureStoreError::Denied {
                what: "a link stores only the master key".into(),
            });
        }
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Zeroizing::new(value));
        Ok(())
    }

    fn delete(&self, _key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.clear()
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.take();
        Ok(())
    }
}

/// The new device's pending link (`pendingLinkCompletion`).
struct NewDevice {
    session_id: String,
    link: DeviceLink,
    key: Arc<HeldKey>,
    /// The server's `expiresAt`, epoch seconds; a vault choice ends with it.
    expires_at: i64,
    /// The answer to the poll that saw the approval, repeated to a poll already in flight then.
    done: Option<LinkPoll>,
}

/// The account's vaults waiting for the user's pick (`pendingVaultChoice`).
struct PendingChoice {
    session_id: String,
    master: Zeroizing<Vec<u8>>,
    vaults: Vec<String>,
    expires_at: i64,
}

pub(super) struct Linking {
    approver: Arc<DeviceApprover>,
    invite: Mutex<Option<String>>,
    /// Polls run one at a time: two in flight would both read the approval.
    new_device: tokio::sync::Mutex<Option<NewDevice>>,
    choice: Mutex<Option<PendingChoice>>,
}

impl Linking {
    pub(super) fn new(approver: Arc<DeviceApprover>) -> Self {
        Self {
            approver,
            invite: Mutex::new(None),
            new_device: tokio::sync::Mutex::new(None),
            choice: Mutex::new(None),
        }
    }
}

/// `dormantVaultFolderName` (`sync/vault-provisioning.ts:16-18`).
pub fn dormant_vault_folder_name(vault_id: &str) -> String {
    let prefix: String = vault_id.chars().take(8).collect();
    format!("memry-vault-{prefix}")
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

impl AccountService {
    /// `GENERATE_LINKING_QR` (`linking-service.ts:177-208`). Replaces a pending code.
    pub async fn generate_linking_qr(&self) -> Result<LinkingQr, AccountError> {
        let invite = self.linking.approver.initiate().await?;
        *lock(&self.linking.invite) = Some(invite.session_id.clone());
        Ok(LinkingQr {
            qr_data: invite.qr_payload,
            session_id: invite.session_id,
            expires_at: invite.expires_at,
        })
    }

    /// `GET_LINKING_SAS` (`linking-service.ts:772-816`): the six digits the approver compares.
    pub async fn linking_sas(&self, session_id: &str) -> Result<String, AccountError> {
        self.pending_invite(session_id)?;
        match self.linking.approver.status().await? {
            ApproverStatus::Scanned { sas_code } => Ok(sas_code),
            ApproverStatus::Waiting | ApproverStatus::Done => Err(AccountError::LinkNotScanned),
            ApproverStatus::Expired => Err(AccountError::LinkSessionExpired),
        }
    }

    /// `APPROVE_LINKING` (`linking-service.ts:653-766`): core verifies the scanning device's
    /// confirm tag before it reads the master key, then seals the key and the account's vault
    /// list for it. The pending code is gone either way.
    pub async fn approve_linking(&self, session_id: &str) -> Result<(), AccountError> {
        self.pending_invite(session_id)?;
        let approved = self.linking.approver.approve().await;
        *lock(&self.linking.invite) = None;
        approved?;
        tracing::info!(scope = "DeviceLinking", "device linking approved");
        Ok(())
    }

    fn pending_invite(&self, session_id: &str) -> Result<(), AccountError> {
        match lock(&self.linking.invite).as_deref() {
            Some(pending) if pending == session_id => Ok(()),
            _ => Err(AccountError::NoPendingLink),
        }
    }

    /// `LINK_VIA_QR` (`linking-service.ts:214-303`): needs the setup token of this sign-in, which
    /// registers the device once the approver sends the key.
    pub async fn link_via_qr(&self, qr_data: String) -> Result<LinkScanned, AccountError> {
        self.ensure_live_setup_token().await?;
        let mut pending = self.linking.new_device.lock().await;
        *pending = None;
        let key = Arc::new(HeldKey::default());
        let link = DeviceLink::new(
            self.transport.clone(),
            key.clone(),
            self.base_url.clone(),
            "desktop".to_owned(),
            self.device.app_version.clone(),
            self.device.name.clone(),
            self.device.platform,
        )?;
        let scan = link.scan(qr_data).await?;
        tracing::info!(scope = "DeviceLinking", "code scanned, awaiting approval");
        *pending = Some(NewDevice {
            session_id: scan.session_id.clone(),
            link,
            key,
            expires_at: scan.expires_at,
            done: None,
        });
        Ok(LinkScanned {
            session_id: scan.session_id,
            verification_code: scan.sas_code,
        })
    }

    /// `COMPLETE_LINKING_QR` (`linking-service.ts:309-552`), one poll. With no vault open the
    /// device registers on its own; with one account vault the open vault is bound to it first;
    /// with two or more the key waits in memory for the user's pick. `on_finalized` gets the
    /// background finalize's device id or error (`sync:linking-finalized`).
    pub async fn complete_linking_qr(
        self: &Arc<Self>,
        session: &Session,
        session_id: &str,
        on_finalized: impl FnOnce(Result<String, AccountError>) + Send + 'static,
    ) -> Result<LinkPoll, AccountError> {
        let mut guard = self.linking.new_device.lock().await;
        let pending = guard
            .as_mut()
            .filter(|p| p.session_id == session_id)
            .ok_or(AccountError::NoPendingLink)?;
        if let Some(done) = &pending.done {
            return Ok(done.clone());
        }
        let vaults = match pending.link.poll_once().await {
            Ok(LinkingPoll::AwaitingApproval) => return Ok(LinkPoll::Waiting),
            Ok(LinkingPoll::Linked { vaults }) => vaults,
            // The poll cadence is the retry: never retried here (`linking-service.ts:349-354`).
            Err(
                LinkingError::PollBudgetExhausted { .. }
                | LinkingError::Api {
                    source: ApiError::RateLimited { .. },
                },
            ) => return Ok(LinkPoll::RateLimited),
            Err(LinkingError::Api {
                source: ApiError::Transport { source },
            }) => {
                tracing::warn!(scope = "DeviceLinking", "linking poll failed: {source}");
                return Ok(LinkPoll::Waiting);
            }
            Err(error) => {
                *guard = None;
                return Err(error.into());
            }
        };
        let master = pending.key.take().ok_or(AccountError::Derive)?;
        let ids: Vec<String> = vaults.into_iter().map(|v| v.id).collect();
        let open = session.current().map(|open| open.vault);
        let outcome = if open.is_some() && ids.len() >= 2 {
            *lock(&self.linking.choice) = Some(PendingChoice {
                session_id: session_id.to_owned(),
                master,
                vaults: ids.clone(),
                expires_at: pending.expires_at,
            });
            tracing::info!(
                scope = "DeviceLinking",
                count = ids.len(),
                "several account vaults: waiting for the user's choice"
            );
            LinkPoll::Linked { vaults: Some(ids) }
        } else {
            let adopt = open.zip(ids.into_iter().next());
            let service = self.clone();
            tokio::spawn(async move {
                on_finalized(service.finalize_link(master, adopt).await);
            });
            LinkPoll::Linked { vaults: None }
        };
        pending.done = Some(outcome.clone());
        Ok(outcome)
    }

    /// `FINALIZE_VAULT_CHOICE` (`linking-service.ts:579-647`): provisions the primary vault in
    /// `<parent>/memry-vault-<id>` without touching the open vault, opens it, then registers the
    /// device. A failed provisioning or open keeps the choice for another try (the outer error);
    /// the other selected vaults stay in the account for the vault switcher. The inner result is
    /// the finalize's, which Electron reports through `sync:linking-finalized`.
    pub async fn finalize_vault_choice(
        &self,
        session: &Session,
        choice: VaultChoice,
    ) -> Result<Result<String, AccountError>, AccountError> {
        let pending = {
            let mut slot = lock(&self.linking.choice);
            let pending = slot
                .take_if(|p| p.session_id == choice.session_id)
                .ok_or(AccountError::NoPendingLink)?;
            if now_s() > pending.expires_at {
                return Err(AccountError::LinkSessionExpired);
            }
            if !choice.selected.contains(&choice.primary)
                || !pending.vaults.contains(&choice.primary)
            {
                *slot = Some(pending);
                return Err(AccountError::VaultChoice(
                    "Primary vault must be among the selected vaults".into(),
                ));
            }
            pending
        };
        let folder =
            Path::new(&choice.parent_folder).join(dormant_vault_folder_name(&choice.primary));
        let opened = {
            let session = session.clone();
            let primary = choice.primary.clone();
            tokio::task::spawn_blocking(move || {
                session.provision_dormant(&folder, &primary)?;
                session.switch(&folder)
            })
            .await
            .map_err(|e| AccountError::VaultChoice(e.to_string()))?
        };
        let opened = match opened {
            Ok(opened) => opened,
            Err(error) => {
                tracing::error!(
                    scope = "DeviceLinking",
                    "finalizeVaultChoice failed: {error}"
                );
                *lock(&self.linking.choice) = Some(pending);
                return Err(AccountError::VaultChoice(error.to_string()));
            }
        };
        let PendingChoice { master, .. } = pending;
        Ok(self
            .finalize_link(master, Some((opened.vault.vault, choice.primary)))
            .await)
    }

    /// `finalizeLinking` (`linking-service.ts:494-552`): the key is checked against the account's
    /// verifier before anything is registered (Electron trusts the SAS alone; a key of another
    /// account fails here instead of being stored under this one), the open vault is bound to the
    /// account's vault, the device registered, and the key stored last.
    async fn finalize_link(
        &self,
        master: Zeroizing<Vec<u8>>,
        adopt: Option<(Arc<Vault>, String)>,
    ) -> Result<String, AccountError> {
        let result = async {
            let _key_op = self.key_op.lock().await;
            self.ensure_live_setup_token().await?;
            let material = self.session.recovery_info().await.map_err(setup_expired)?;
            let verifier = keys::account_key_verifier(&master).map_err(|_| AccountError::Derive)?;
            if !keys::account_key_verifier_matches(&verifier, &material.key_verifier) {
                return Err(AccountError::LinkedKeyMismatch);
            }
            if let Some((vault, server_id)) = adopt {
                bind(vault, server_id).await;
            }
            let device_id = self.register().await?;
            self.keep_master_key(&master, &verifier, &device_id)?;
            Ok(device_id)
        }
        .await;
        match &result {
            Ok(_) => tracing::info!(scope = "DeviceLinking", "device linking finalized"),
            Err(error) => tracing::error!(
                scope = "DeviceLinking",
                "linking finalization failed: {error}"
            ),
        }
        result
    }
}

/// `adoptVaultLocally` on the open vault. A vault already bound to another server vault keeps
/// its binding (the account binding decides about it, lane A4); the device still registers.
async fn bind(vault: Arc<Vault>, server_id: String) {
    match tokio::task::spawn_blocking(move || vault.bind_server_vault(&server_id)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(
            scope = "DeviceLinking",
            "the open vault was not bound to the account's vault: {error}"
        ),
        Err(error) => tracing::warn!(scope = "DeviceLinking", "vault bind task failed: {error}"),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The link's store holds the master key and nothing else, and never reads one back: the
    /// link cannot leave a device key or token in memory, nor read the keychain through it.
    #[test]
    fn the_held_key_takes_only_the_master_key() {
        let held = HeldKey::default();
        for key in [
            SecureStoreKey::DeviceSigningKey,
            SecureStoreKey::AccessToken,
            SecureStoreKey::RefreshToken,
            SecureStoreKey::SetupToken,
        ] {
            assert!(held.set(key, vec![1; 32]).is_err(), "{key:?}");
        }
        assert_eq!(held.take(), None);

        held.set(SecureStoreKey::MasterKey, vec![2; 32]).unwrap();
        assert_eq!(held.get(SecureStoreKey::MasterKey).unwrap(), None);
        assert_eq!(
            held.take().as_deref().map(Vec::as_slice),
            Some(&[2; 32][..])
        );
        assert_eq!(held.take(), None, "taken once");
    }
}
