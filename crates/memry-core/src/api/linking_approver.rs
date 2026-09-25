//! Device linking's **approver half** (spec 006 ST14): this phone shows a QR
//! and approves the new device that scans it, exactly as desktop's
//! `linking-service.ts` `initiateDeviceLinking` / `approveDeviceLinking` do.
//!
//! Three calls, each one request, no loop (spec-defect 90/108): `initiate`
//! (`POST /auth/linking/initiate`), `status` (`GET /auth/linking/session/:id`,
//! which also yields the SAS once scanned) and `approve`
//! (`POST /auth/linking/approve`). The shell polls `status` on its own timer.
//!
//! `approve` follows §3.9's ordering: the new device's `newDeviceConfirm` is
//! verified under the confirm-channel key **before** the master key is read
//! from the secure store; the master key is sealed with no AAD, the vault
//! transfer under `vault-transfer-v1:<sessionId>`. The master key never
//! crosses the FFI.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value as Json, json};
use zeroize::Zeroizing;

use crate::api::auth::AuthSession;
use crate::api::errors::ApiError;
use crate::crypto::sodium;
use crate::protocol::account;
use crate::protocol::http::{ApiRequest, Auth, HttpClient};
use crate::protocol::linking::transfer::{VAULT_TRANSFER_AAD_PREFIX, VAULT_TRANSFER_VERSION};
use crate::protocol::linking::{
    self, LinkingError, confirm_mac, linking_proof_message, vault_transfer_confirm_message,
    verify_confirm_mac,
};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};

const NONCE_BYTES: usize = 24;

/// What the approver's sheet shows.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LinkingInvite {
    pub session_id: String,
    /// The QR payload, desktop's `JSON.stringify({sessionId, ephemeralPublicKey,
    /// linkingSecret, expiresAt})`. Also what a new device can paste.
    pub qr_payload: String,
    /// Epoch seconds.
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ApproverStatus {
    /// No device has scanned yet.
    Waiting,
    /// A device scanned; compare `sas_code` with the one it shows, then approve.
    Scanned {
        sas_code: String,
    },
    /// Approved or completed.
    Done,
    Expired,
}

struct Pending {
    session_id: String,
    expires_at: i64,
    secret: Zeroizing<Vec<u8>>,
}

#[derive(uniffi::Object)]
pub struct DeviceApprover {
    http: Arc<HttpClient>,
    store: Arc<dyn SecureStore>,
    pending: Mutex<Option<Pending>>,
}

/// The `approve` body, built offline so it can be tested without a server.
pub(crate) fn approval_body(
    session_id: &str,
    my_secret: &[u8],
    device_public_b64: &str,
    device_confirm_b64: &str,
    master_key: &[u8],
    vault_ids: &[String],
) -> Result<Json, LinkingError> {
    let device_public = linking::decode_b64("newDevicePublicKey", device_public_b64)?;
    let shared = linking::shared_secret(my_secret, &device_public)?;
    let subkeys = linking::derive_subkeys(&shared)?;
    let proof = linking_proof_message(session_id, device_public_b64)?;
    verify_confirm_mac(&proof, device_confirm_b64, &subkeys.mac)?;

    let nonce = sodium::random_bytes(NONCE_BYTES);
    let (block, key_confirm) = linking::send_master_key(session_id, master_key, &subkeys, &nonce)?;
    let mut body = json!({
        "sessionId": session_id,
        "encryptedMasterKey": block.encrypted_master_key_b64,
        "encryptedKeyNonce": block.encrypted_key_nonce_b64,
        "keyConfirm": B64.encode(key_confirm),
    });
    if !vault_ids.is_empty() {
        let plaintext = json!({
            "version": VAULT_TRANSFER_VERSION,
            "vaults": vault_ids.iter().map(|id| json!({"vaultUuid": id})).collect::<Vec<_>>(),
        })
        .to_string();
        let nonce = sodium::random_bytes(NONCE_BYTES);
        let aad = format!("{VAULT_TRANSFER_AAD_PREFIX}{session_id}");
        let ciphertext = sodium::aead_encrypt(
            plaintext.as_bytes(),
            Some(aad.as_bytes()),
            &nonce,
            &subkeys.encryption,
        )?;
        let ciphertext_b64 = B64.encode(ciphertext);
        let confirm = confirm_mac(
            &vault_transfer_confirm_message(session_id, &ciphertext_b64)?,
            &subkeys.mac,
        )?;
        body["encryptedVaultTransfer"] = json!(ciphertext_b64);
        body["encryptedVaultTransferNonce"] = json!(B64.encode(nonce));
        body["vaultTransferConfirm"] = json!(B64.encode(confirm));
        body["vaultTransferVersion"] = json!(VAULT_TRANSFER_VERSION);
    }
    Ok(body)
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn malformed(path: &str, what: &str) -> LinkingError {
    LinkingError::Api {
        source: ApiError::MalformedResponse {
            path: path.into(),
            what: what.into(),
        },
    }
}

#[uniffi::export]
impl AuthSession {
    /// The approver half of linking over this session.
    pub fn device_approver(&self) -> Arc<DeviceApprover> {
        Arc::new(DeviceApprover {
            http: self.http(),
            store: self.secure_store(),
            pending: Mutex::new(None),
        })
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl DeviceApprover {
    /// `POST /auth/linking/initiate`. Replaces any pending invite.
    pub async fn initiate(&self) -> Result<LinkingInvite, LinkingError> {
        self.cancel();
        let (public, secret) = linking::ephemeral_keypair()?;
        let public_b64 = B64.encode(&public);
        let path = "/auth/linking/initiate";
        let body: Json = self
            .http
            .send_json(
                ApiRequest::post(path)
                    .auth(Auth::Session)
                    .json(&json!({ "ephemeralPublicKey": public_b64 })),
            )
            .await?;
        let session_id = body["sessionId"]
            .as_str()
            .ok_or_else(|| malformed(path, "no sessionId"))?
            .to_owned();
        let expires_at = body["expiresAt"]
            .as_i64()
            .ok_or_else(|| malformed(path, "no expiresAt"))?;
        let linking_secret = body["linkingSecret"]
            .as_str()
            .ok_or_else(|| malformed(path, "no linkingSecret"))?;
        let qr_payload = json!({
            "sessionId": session_id,
            "ephemeralPublicKey": public_b64,
            "linkingSecret": linking_secret,
            "expiresAt": expires_at,
        })
        .to_string();
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending {
            session_id: session_id.clone(),
            expires_at,
            secret,
        });
        Ok(LinkingInvite {
            session_id,
            qr_payload,
            expires_at,
        })
    }

    /// One `GET /auth/linking/session/:id`.
    pub async fn status(&self) -> Result<ApproverStatus, LinkingError> {
        let (session_id, secret) = self.current()?;
        if now_s() > self.expiry() {
            self.cancel();
            return Ok(ApproverStatus::Expired);
        }
        let session = self.session(&session_id).await?;
        let status = session["status"].as_str().unwrap_or_default();
        match status {
            "approved" | "completed" => Ok(ApproverStatus::Done),
            "expired" => Ok(ApproverStatus::Expired),
            _ => match session["newDevicePublicKey"].as_str() {
                Some(public_b64) => {
                    let public = linking::decode_b64("newDevicePublicKey", public_b64)?;
                    let shared = linking::shared_secret(&secret, &public)?;
                    Ok(ApproverStatus::Scanned {
                        sas_code: linking::short_verification_code(&shared)?,
                    })
                }
                None => Ok(ApproverStatus::Waiting),
            },
        }
    }

    /// Verifies the scanning device, seals the master key and the account's
    /// vault list, and posts `POST /auth/linking/approve`. The invite is
    /// cleared either way.
    pub async fn approve(&self) -> Result<(), LinkingError> {
        let (session_id, secret) = self.current()?;
        let result = async {
            let session = self.session(&session_id).await?;
            let path = "/auth/linking/session";
            let public = session["newDevicePublicKey"]
                .as_str()
                .ok_or(LinkingError::NotScanned)?;
            let confirm = session["newDeviceConfirm"]
                .as_str()
                .ok_or_else(|| malformed(path, "no newDeviceConfirm"))?;
            // Verified inside `approval_body` before the key is used; read the
            // key only after the session answered.
            let master_key = Zeroizing::new(self.store.get(SecureStoreKey::MasterKey)?.ok_or(
                LinkingError::InvalidLength {
                    what: "master key".into(),
                    expected: 32,
                    actual: 0,
                },
            )?);
            let vaults: Vec<String> = account::vaults(&self.http)
                .await
                .map(|rows| rows.into_iter().map(|v| v.id).collect())
                .unwrap_or_default();
            let body = approval_body(&session_id, &secret, public, confirm, &master_key, &vaults)?;
            let _: Json = self
                .http
                .send_json(
                    ApiRequest::post("/auth/linking/approve")
                        .auth(Auth::Session)
                        .json(&body),
                )
                .await?;
            Ok(())
        }
        .await;
        self.cancel();
        result
    }

    /// Drops the pending invite and its ephemeral secret. Blocking, no I/O.
    pub fn cancel(&self) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl DeviceApprover {
    fn current(&self) -> Result<(String, Zeroizing<Vec<u8>>), LinkingError> {
        let guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending = guard.as_ref().ok_or(LinkingError::NotScanned)?;
        Ok((pending.session_id.clone(), pending.secret.clone()))
    }

    fn expiry(&self) -> i64 {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| p.expires_at)
            .unwrap_or(0)
    }

    async fn session(&self, session_id: &str) -> Result<Json, LinkingError> {
        if !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(malformed("/auth/linking/session", "bad session id"));
        }
        Ok(self
            .http
            .send_json(
                ApiRequest::get(&format!("/auth/linking/session/{session_id}")).auth(Auth::Session),
            )
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::linking::MasterKeyBlock;
    use crate::protocol::linking::routes::EncryptedBlock;
    use crate::protocol::linking::transfer::open_vault_transfer;

    /// The approver's body opens on the new device's side with the new
    /// device's own code (`receive_master_key`, `open_vault_transfer`).
    #[test]
    fn an_approval_round_trips_through_the_new_device_half() {
        let session = "3f2a0c1e-0000-4000-8000-000000000001";
        let (approver_public, approver_secret) = linking::ephemeral_keypair().expect("a");
        let (device_public, device_secret) = linking::ephemeral_keypair().expect("d");
        let device_public_b64 = B64.encode(&device_public);

        // The new device's view of the agreement, and its newDeviceConfirm.
        let shared = linking::shared_secret(&device_secret, &approver_public).expect("s");
        let device_keys = linking::derive_subkeys(&shared).expect("k");
        let proof = linking_proof_message(session, &device_public_b64).expect("p");
        let device_confirm = B64.encode(confirm_mac(&proof, &device_keys.mac).expect("m"));

        let master = vec![7u8; 32];
        let body = approval_body(
            session,
            &approver_secret,
            &device_public_b64,
            &device_confirm,
            &master,
            &["vault-1".into()],
        )
        .expect("body");

        let block = MasterKeyBlock {
            encrypted_master_key_b64: body["encryptedMasterKey"].as_str().expect("k").into(),
            encrypted_key_nonce_b64: body["encryptedKeyNonce"].as_str().expect("n").into(),
        };
        let opened = linking::receive_master_key(
            session,
            &block,
            body["keyConfirm"].as_str().expect("c"),
            &device_keys,
        )
        .expect("open");
        assert_eq!(opened.to_vec(), master);

        let vaults = open_vault_transfer(
            session,
            &EncryptedBlock {
                ciphertext_b64: body["encryptedVaultTransfer"].as_str().expect("v").into(),
                nonce_b64: body["encryptedVaultTransferNonce"]
                    .as_str()
                    .expect("v")
                    .into(),
                confirm_b64: body["vaultTransferConfirm"].as_str().expect("v").into(),
            },
            &device_keys,
        )
        .expect("transfer");
        assert_eq!(vaults[0].id, "vault-1");
    }

    #[test]
    fn a_device_confirm_that_does_not_verify_is_refused_before_sealing() {
        let (_, approver_secret) = linking::ephemeral_keypair().expect("a");
        let (device_public, _) = linking::ephemeral_keypair().expect("d");
        let refused = approval_body(
            "s",
            &approver_secret,
            &B64.encode(device_public),
            &B64.encode([0u8; 32]),
            &[7u8; 32],
            &[],
        );
        assert!(matches!(refused, Err(LinkingError::ConfirmMacInvalid)));
    }
}
