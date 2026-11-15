//! First-device setup, the recovery phrase and the two ways back in: the phrase
//! (`LINK_VIA_RECOVERY`) and the known device (`signInKnownDevice`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::auth::AuthState;
use memry_core::api::errors::{ApiError, AuthError};
use memry_core::crypto::{keys, recovery};
use memry_core::seams::secure_store::SecureStoreKey;
use serde_json::Value;
use zeroize::Zeroizing;

use super::{AccountError, AccountService};

impl AccountService {
    /// `SETUP_NEW_ACCOUNT` (`ipc/auth-device-handlers.ts:144-178,349-364`): a new phrase and
    /// salt, the master key derived from them, the device registered, the account's key material
    /// published, and the master key stored. Returns the server's device id; the phrase waits
    /// for [`Self::recovery_phrase`].
    pub async fn setup_new_account(&self) -> Result<String, AccountError> {
        let _key_op = self.key_op.lock().await;
        let phrase = recovery::generate_phrase();
        let salt = keys::generate_kdf_salt();
        let master = derive(phrase.to_string(), salt.clone()).await?;
        let verifier = keys::account_key_verifier(&master).map_err(|_| AccountError::Derive)?;
        let device_id = self.register().await?;
        // Electron logs a failed `/auth/setup` and goes on (`device-registration.ts:160-171`).
        // A 409 is the one answer that is not "retry later": another device published first,
        // so this phrase is not the account's and is never shown. The device is registered with
        // no master key; the account's phrase links it (`link_via_recovery`).
        match self
            .session
            .complete_account_setup(BASE64.encode(&salt), verifier.clone())
            .await
        {
            Err(ApiError::Status { status: 409, .. }) => return Err(AccountError::SetupConflict),
            Err(error) => {
                tracing::error!(
                    scope = "Account",
                    "publishing the account keys failed: {error}"
                );
            }
            Ok(()) => {}
        }
        // Held before any local write: once the keys may be published, a failed write must not
        // take the only copy of the phrase with it.
        *self.phrase.lock().unwrap_or_else(|e| e.into_inner()) = Some(phrase);
        self.keep_master_key(&master, &verifier, &device_id)?;
        if let Err(error) = self.write_sync(|sync| {
            sync.insert("recoveryPhraseConfirmed".into(), Value::Bool(false));
        }) {
            tracing::warn!(
                scope = "Account",
                "the unconfirmed phrase could not be recorded: {error}"
            );
        }
        Ok(device_id)
    }

    /// `GET_RECOVERY_PHRASE` (`ipc/auth-oauth-handlers.ts:305-307`).
    pub fn recovery_phrase(&self) -> Option<Zeroizing<String>> {
        self.phrase
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// `CONFIRM_RECOVERY_PHRASE` (`ipc/auth-oauth-handlers.ts:279-301`).
    pub fn confirm_recovery_phrase(&self, confirmed: bool) -> Result<(), AccountError> {
        if confirmed {
            self.write_sync(|sync| {
                sync.insert("recoveryPhraseConfirmed".into(), Value::Bool(true));
            })?;
            *self.phrase.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        Ok(())
    }

    /// `LINK_VIA_RECOVERY` (`ipc/auth-device-handlers.ts:427-489`): the phrase must derive the
    /// account's verifier before anything is registered or stored. A device already registered
    /// without a master key (a setup another device finished first) reads the account's key
    /// material over its session and is not registered twice.
    pub async fn link_via_recovery(&self, phrase: String) -> Result<String, AccountError> {
        let phrase = Zeroizing::new(phrase);
        let _key_op = self.key_op.lock().await;
        let canonical = Zeroizing::new(
            recovery::validate_phrase(&phrase).map_err(|_| AccountError::InvalidPhrase)?,
        );
        let registered = match self.session.state() {
            AuthState::Registered | AuthState::Refreshing | AuthState::SessionExpired => {
                Some(self.session.registered_device_id()?)
            }
            _ => None,
        };
        let material = if registered.is_some() {
            self.session.key_material().await?
        } else {
            self.ensure_live_setup_token().await?;
            self.session.recovery_info().await.map_err(setup_expired)?
        };
        let salt = BASE64
            .decode(&material.kdf_salt)
            .map_err(|_| AccountError::Derive)?;
        let master = derive(canonical.to_string(), salt).await?;
        let verifier = keys::account_key_verifier(&master).map_err(|_| AccountError::Derive)?;
        if !keys::account_key_verifier_matches(&verifier, &material.key_verifier) {
            return Err(AccountError::PhraseMismatch);
        }
        let device_id = match registered {
            Some(device_id) => device_id,
            None => self.register().await?,
        };
        self.keep_master_key(&master, &verifier, &device_id)?;
        Ok(device_id)
    }

    /// `signInKnownDevice` (`sync/device-registration.ts:285-327`): the device keeps its keys and
    /// gets new tokens when it still holds both keys and its master key is the account's. `None`
    /// sends the user to the phrase. A locked keychain is an error, never a phrase prompt.
    pub(super) async fn sign_in_known_device(&self) -> Result<Option<String>, AccountError> {
        let _key_op = self.key_op.lock().await;
        let master = self
            .store
            .get(SecureStoreKey::MasterKey)?
            .map(Zeroizing::new);
        let signing = self.store.get(SecureStoreKey::DeviceSigningKey)?;
        let Some(master) = master.filter(|_| signing.is_some()) else {
            tracing::info!(
                scope = "Account",
                "recovery phrase needed: the device keys are gone"
            );
            return Ok(None);
        };
        let material = match self.session.recovery_info().await {
            Ok(material) => material,
            Err(error) => {
                tracing::warn!(scope = "Account", "known-device check failed: {error}");
                return Ok(None);
            }
        };
        let verifier = keys::account_key_verifier(&master).map_err(|_| AccountError::Derive)?;
        if !keys::account_key_verifier_matches(&verifier, &material.key_verifier) {
            tracing::info!(
                scope = "Account",
                "recovery phrase needed: not the account's key"
            );
            return Ok(None);
        }
        match self.register().await {
            Ok(device_id) => {
                self.keep_master_key(&master, &verifier, &device_id)?;
                tracing::info!(scope = "Account", "signed a known device back in");
                Ok(Some(device_id))
            }
            Err(AccountError::KeychainUnavailable) => Err(AccountError::KeychainUnavailable),
            Err(error) => {
                tracing::warn!(
                    scope = "Account",
                    "known-device registration failed: {error}"
                );
                Ok(None)
            }
        }
    }

    /// `POST /auth/devices`, then the server's id. A failed registration keeps the device key:
    /// it exists before any account and names this device in offline clocks (difference 9 of the
    /// plan; Electron deletes it, `device-registration.ts:142`).
    pub(super) async fn register(&self) -> Result<String, AccountError> {
        self.ensure_live_setup_token().await?;
        self.session
            .register_device()
            .await
            .map_err(setup_expired)?;
        Ok(self.session.registered_device_id()?)
    }

    /// Electron's `ensureLiveSetupToken` (`sync/setup-token.ts:109-113`): a setup token that
    /// aged out, by the server's `401` or by its own `exp`, is renewed in place; one that cannot
    /// be is "sign in again".
    pub(super) async fn ensure_live_setup_token(&self) -> Result<(), AccountError> {
        self.session.live_setup_token().await.map_err(|error| {
            tracing::warn!(
                scope = "Account",
                "the setup token could not be renewed: {error}"
            );
            AccountError::SetupSessionExpired
        })?;
        Ok(())
    }

    /// The master key and what names it: `sync.accountKeyVerifier` (offline key checks) and
    /// `sync.deviceId`, the server's id (`device-registration.ts:174-205`). The config write is a
    /// cache Electron writes best-effort (`device-registration.ts:178-187`): a failure is logged
    /// and the key stays.
    pub(super) fn keep_master_key(
        &self,
        master: &[u8],
        verifier: &str,
        device_id: &str,
    ) -> Result<(), AccountError> {
        self.store.set(SecureStoreKey::MasterKey, master.to_vec())?;
        if let Err(error) = self.write_sync(|sync| {
            sync.insert("accountKeyVerifier".into(), Value::from(verifier));
            sync.insert("deviceId".into(), Value::from(device_id));
        }) {
            tracing::warn!(
                scope = "Account",
                "the account key verifier could not be cached: {error}"
            );
        }
        Ok(())
    }
}

/// A `401` on the setup token is Electron's "sign in again" (`auth-device-handlers.ts:200-202`).
pub(super) fn setup_expired(error: AuthError) -> AccountError {
    match error {
        AuthError::Api {
            source: ApiError::Unauthorized { .. },
        }
        | AuthError::NoSetupToken => AccountError::SetupSessionExpired,
        other => other.into(),
    }
}

/// Argon2id (64 MiB, three passes) off the async workers.
async fn derive(phrase: String, salt: Vec<u8>) -> Result<Zeroizing<Vec<u8>>, AccountError> {
    let phrase = Zeroizing::new(phrase);
    tokio::task::spawn_blocking(move || {
        let seed = recovery::phrase_to_seed(&phrase).map_err(|_| AccountError::InvalidPhrase)?;
        keys::derive_master_key(seed.as_slice(), &salt).map_err(|_| AccountError::Derive)
    })
    .await
    .map_err(|_| AccountError::Derive)?
}
