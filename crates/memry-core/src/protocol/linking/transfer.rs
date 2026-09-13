//! §3.10's `encryptedVaultTransfer` block: verify, then decrypt, then read.
//!
//! **Hard-fail, and that is the whole reason this file exists.** §3.10 makes
//! provider auth soft-fail — present and undecryptable is a warning, and a
//! client MAY ignore the block entirely, so this core does — while a vault
//! transfer that is present and fails its MAC or its decrypt MUST fail the link
//! and clear the session. Absent is not a failure: the client proceeds with an
//! empty vault list.
//!
//! **The AAD asymmetry is real** (§3.10). The master key block carries **no**
//! associated data; this block carries `vault-transfer-v1:<sessionId>`. Getting
//! either one wrong produces a block the peer cannot open, with no other
//! symptom.

use serde_json::Value as Json;

use super::routes::EncryptedBlock;
use super::{
    LinkingError, LinkingSubkeys, decode_b64, vault_transfer_confirm_message, verify_confirm_mac,
};
use crate::crypto::sodium;
use crate::protocol::account::VaultSummary;

/// §3.10, `apps/desktop/src/main/sync/vault-transfer.ts:9`.
pub const VAULT_TRANSFER_AAD_PREFIX: &str = "vault-transfer-v1:";

/// The block's `version` field, `z.literal(1)`.
pub const VAULT_TRANSFER_VERSION: u64 = 1;

/// Verifies `vaultTransferConfirm` and decrypts the block, §3.9's ordering.
///
/// The verify is first and there is no path past it, for the same structural
/// reason [`super::receive_master_key`] has none: a rule that must be
/// remembered is a rule that is eventually forgotten in a refactor.
///
/// The rows cross as [`VaultSummary`], the record `AuthSession::vaults`
/// already returns. §3.10 notes the transferred list is a copy of
/// `GET /sync/vaults`, so a shell's vault picker should not have to switch on
/// which of the two paths produced its list; the one thing the transfer adds is
/// the initiator's current vault when the server list is still empty, which is
/// exactly FR-021's first-vault default. `name` is `None` because the transfer
/// carries `vaultUuid`, `itemCount` and `createdAt` and no name at all.
pub fn open_vault_transfer(
    session_id: &str,
    block: &EncryptedBlock,
    subkeys: &LinkingSubkeys,
) -> Result<Vec<VaultSummary>, LinkingError> {
    let message = vault_transfer_confirm_message(session_id, &block.ciphertext_b64)?;
    verify_confirm_mac(&message, &block.confirm_b64, &subkeys.mac)?;

    let ciphertext = decode_b64("encryptedVaultTransfer", &block.ciphertext_b64)?;
    let nonce = decode_b64("encryptedVaultTransferNonce", &block.nonce_b64)?;
    let aad = format!("{VAULT_TRANSFER_AAD_PREFIX}{session_id}");
    let plaintext = sodium::aead_decrypt(
        &ciphertext,
        Some(aad.as_bytes()),
        &nonce,
        &subkeys.encryption,
    )?;

    read_vault_transfer(&plaintext)
}

fn read_vault_transfer(plaintext: &[u8]) -> Result<Vec<VaultSummary>, LinkingError> {
    let json: Json =
        serde_json::from_slice(plaintext).map_err(|_| LinkingError::InvalidVaultTransfer {
            what: "plaintext is not JSON".into(),
        })?;
    if json.get("version").and_then(Json::as_u64) != Some(VAULT_TRANSFER_VERSION) {
        return Err(LinkingError::InvalidVaultTransfer {
            what: "not version 1".into(),
        });
    }
    let rows = json.get("vaults").and_then(Json::as_array).ok_or_else(|| {
        LinkingError::InvalidVaultTransfer {
            what: "no vaults array".into(),
        }
    })?;

    rows.iter()
        .map(|row| {
            // A row whose id cannot be read fails the whole block, exactly as
            // `protocol::account::read_vaults` does: an unreadable row reported
            // as a shorter list is the failure that told an account holding
            // four vaults it had none.
            row.get("vaultUuid")
                .and_then(Json::as_str)
                .map(|id| VaultSummary {
                    id: id.to_string(),
                    name: None,
                })
                .ok_or_else(|| LinkingError::InvalidVaultTransfer {
                    what: "a vault row carries no vaultUuid".into(),
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rows_of_a_version_1_block_are_read() {
        let plaintext =
            br#"{"version":1,"vaults":[{"vaultUuid":"v1","itemCount":3},{"vaultUuid":"v2"}]}"#;
        assert_eq!(
            read_vault_transfer(plaintext).expect("rows"),
            vec![
                VaultSummary {
                    id: "v1".into(),
                    name: None
                },
                VaultSummary {
                    id: "v2".into(),
                    name: None
                },
            ]
        );
    }

    /// The three ways the plaintext can be wrong are three refusals, and none
    /// of them is an empty vault list.
    #[test]
    fn a_block_that_cannot_be_read_is_never_an_empty_vault_list() {
        for plaintext in [
            &b"{"[..],
            &br#"{"version":2,"vaults":[]}"#[..],
            &br#"{"version":1}"#[..],
            &br#"{"version":1,"vaults":[{"itemCount":3}]}"#[..],
        ] {
            assert!(
                matches!(
                    read_vault_transfer(plaintext),
                    Err(LinkingError::InvalidVaultTransfer { .. })
                ),
                "{plaintext:?} must not read as an empty list"
            );
        }
    }
}
