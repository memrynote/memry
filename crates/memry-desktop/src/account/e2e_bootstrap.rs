//! The e2e harness's sign-in, Electron's `bootstrapSyncDevice` (`main/test-hooks.ts:280-306`):
//! a device joins the account the harness made on the local test server without an email code
//! or a phrase. Compiled only with the `e2e` feature.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::crypto::keys;
use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;

use super::{AccountError, AccountService};
use crate::registry::VaultRegistry;
use crate::session::OpenVault;

/// What the harness made for one device (`SharedSyncBootstrap.deviceA`, `harness/sync-backend.ts`).
/// `signingSecretKeyBase64` is not read: the device registers with the key it minted at launch,
/// which already names it in the open vault's clocks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eDevice {
    pub email: String,
    /// Signed with the test server's key for the harness's user.
    pub setup_token: String,
    /// The account's vault, shared by every device the harness bootstraps.
    pub vault_id: String,
    pub master_key_base64: String,
    pub kdf_salt: String,
    pub key_verifier: String,
    /// The account's keys are already published (the second device).
    #[serde(default)]
    pub skip_setup: bool,
}

impl AccountService {
    /// Registers this device with its own signing key, binds the open vault to the account's
    /// vault for this account whatever it holds (`adoptVaultLocally`), publishes the key material
    /// unless `skip_setup`, then keeps the master key and a confirmed phrase, as
    /// `persistKeysAndRegisterDevice` (`sync/device-registration.ts:115-200`) does. Returns the
    /// server's device id. The caller attaches sync.
    pub async fn bootstrap_e2e_device(
        &self,
        open: &OpenVault,
        registry: &VaultRegistry,
        device: E2eDevice,
    ) -> Result<String, AccountError> {
        let _key_op = self.key_op.lock().await;
        let master = Zeroizing::new(
            BASE64
                .decode(&device.master_key_base64)
                .map_err(|_| AccountError::Derive)?,
        );
        let verifier = keys::account_key_verifier(&master).map_err(|_| AccountError::Derive)?;
        if !keys::account_key_verifier_matches(&verifier, &device.key_verifier) {
            return Err(AccountError::PhraseMismatch);
        }
        self.session
            .accept_e2e_setup_token(device.email.clone(), &device.setup_token)?;
        let device_id = self.register().await?;
        let user_id = self.session.account_user_id().ok_or_else(|| {
            AccountError::VaultChoice("the registration named no account user".into())
        })?;
        self.bind_for_sync(open, registry, &user_id, Some(&device.vault_id))?;
        if !device.skip_setup {
            self.session
                .complete_account_setup(device.kdf_salt, device.key_verifier)
                .await?;
        }
        self.keep_master_key(&master, &verifier, &device_id)?;
        self.write_sync(|sync| {
            sync.insert("email".into(), Value::from(device.email));
            sync.insert("recoveryPhraseConfirmed".into(), Value::Bool(true));
        })?;
        Ok(device_id)
    }
}
