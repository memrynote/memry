//! The signed-in account on this install: email sign-in, first-device setup, the recovery phrase
//! and the known-device path, over the one `AuthSession` the app builds (Step 19, #3536).
//!
//! The session owns the auth machine, the tokens and the device key; this service owns what
//! Electron kept beside them: the `sync` section of `memry-config.json` (`email`, `deviceId`,
//! `accountKeyVerifier`, `recoveryPhraseConfirmed`, Electron's names and types, which Step 37
//! imports), the master key write, and the phrase shown once after setup. Sync is not started
//! here: the master key lands in the keychain and the sync supervisor picks it up (A4).

mod adopt;
pub mod binding;
pub mod device;
mod devices;
mod linking;
mod oauth;
pub mod otp_clipboard;
mod recovery;
pub mod session_events;
mod teardown;
pub mod vault_directory;
pub mod vault_sync;

pub use devices::DeviceList;
pub use linking::{LinkPoll, LinkScanned, LinkingQr, VaultChoice, dormant_vault_folder_name};
pub use memry_core::protocol::auth::DeviceFormFactor;
pub use oauth::{FirstDevice, OAUTH_ATTEMPT_TTL, OAuthEvent, OAuthStarted};
pub use teardown::SignedOut;

use std::sync::{Arc, Mutex};

use memry_core::api::auth::{AuthSession, AuthState, DeviceDescriptor};
use memry_core::api::errors::{ApiError, AuthError, SecureStoreError};
use memry_core::protocol::linking::LinkingError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::Transport;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::error::{CoreError, FailureKind};
use crate::registry::config::{AppConfig, ConfigError};

/// Why an account call failed. Messages never carry a phrase, a key or a token.
#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// The keychain could not be read. Never a reason to mint or to ask for the phrase.
    #[error("the keychain is unavailable")]
    KeychainUnavailable,
    /// The setup token ran out and could not be renewed (Electron #1202).
    #[error("the sign-in timed out before setup finished")]
    SetupSessionExpired,
    #[error("the recovery phrase is not a valid phrase")]
    InvalidPhrase,
    #[error("the recovery phrase does not match this account")]
    PhraseMismatch,
    /// Another device published the account's key material first: the phrase this device made
    /// is not the account's, so it is dropped before the user writes it down.
    #[error("another device set up this account first")]
    SetupConflict,
    #[error("key derivation failed")]
    Derive,
    #[error(transparent)]
    Linking(#[from] LinkingError),
    #[error("No pending linking session found")]
    NoPendingLink,
    #[error("Session has not been scanned yet")]
    LinkNotScanned,
    #[error("Linking session has expired")]
    LinkSessionExpired,
    /// The approver sent a key that is not this account's (its verifier does not match).
    #[error("the linked key does not belong to this account")]
    LinkedKeyMismatch,
    #[error("{0}")]
    VaultChoice(String),
    #[error("this device cannot remove itself")]
    CannotRemoveCurrentDevice,
    /// The server's answer to the sign-in request named no `https` provider URL with a `state`.
    #[error("the server gave no usable sign-in link")]
    OAuthInvalidResponse,
    /// The browser attempt ended (declined, expired, or already used).
    #[error("the sign-in attempt expired")]
    OAuthExpired,
    #[error("the sign-in loopback could not start")]
    OAuthLoopback,
    /// `deleteAccountVault` refuses the open vault (`vault-directory.ts:250-252`).
    #[error("Cannot delete the active vault. Switch to another vault first.")]
    DeleteOpenVault,
    #[error("Sign in to delete a vault from your account.")]
    DeleteSignedOut,
    #[error("the vault list could not be saved: {0}")]
    VaultList(String),
    /// A vault id that cannot name a folder (`account_admin::segment`).
    #[error("The account vault's id is not valid")]
    InvalidVaultId,
    #[error("Could not create the vault folder: {0}")]
    VaultDownload(String),
}

impl From<SecureStoreError> for AccountError {
    fn from(error: SecureStoreError) -> Self {
        match error {
            SecureStoreError::Locked => Self::KeychainUnavailable,
            other => Self::Auth(other.into()),
        }
    }
}

impl CoreError for AccountError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Auth(AuthError::SecureStore {
                source: SecureStoreError::Locked,
            })
            | Self::KeychainUnavailable => (FailureKind::Locked, "keychain_unavailable"),
            Self::Auth(error) => error.kind_and_code(),
            Self::Api(error) => error.kind_and_code(),
            Self::Config(_) => (FailureKind::Storage, "config_unwritable"),
            Self::SetupSessionExpired => (FailureKind::Auth, "setup_session_expired"),
            Self::InvalidPhrase => (FailureKind::Invalid, "invalid_recovery_phrase"),
            Self::PhraseMismatch => (FailureKind::Auth, "recovery_phrase_mismatch"),
            Self::SetupConflict => (FailureKind::Auth, "account_setup_conflict"),
            Self::Derive => (FailureKind::Crypto, "key_derivation_failed"),
            Self::Linking(LinkingError::Api { source }) => source.kind_and_code(),
            Self::Linking(LinkingError::SecureStore { source }) => source.kind_and_code(),
            Self::Linking(LinkingError::SessionExpired) | Self::LinkSessionExpired => {
                (FailureKind::Auth, "linking_session_expired")
            }
            Self::Linking(LinkingError::InvalidQrPayload { .. }) => {
                (FailureKind::Invalid, "linking_invalid_qr")
            }
            Self::Linking(_) => (FailureKind::Crypto, "linking_failed"),
            Self::NoPendingLink => (FailureKind::NotFound, "linking_no_session"),
            Self::LinkNotScanned => (FailureKind::Invalid, "linking_not_scanned"),
            Self::LinkedKeyMismatch => (FailureKind::Crypto, "linking_key_mismatch"),
            Self::VaultChoice(_) => (FailureKind::Storage, "linking_vault_choice_failed"),
            Self::CannotRemoveCurrentDevice => {
                (FailureKind::Invalid, "cannot_remove_current_device")
            }
            Self::OAuthInvalidResponse => (FailureKind::Api, "oauth_invalid_response"),
            Self::OAuthExpired => (FailureKind::Auth, "oauth_expired"),
            Self::OAuthLoopback => (FailureKind::Internal, "oauth_loopback_unavailable"),
            Self::DeleteOpenVault => (FailureKind::Invalid, "vault_is_open"),
            Self::DeleteSignedOut => (FailureKind::Auth, "signed_out"),
            Self::VaultList(_) => (FailureKind::Storage, "vault_list_unwritable"),
            Self::InvalidVaultId => (FailureKind::Invalid, "invalid_vault_id"),
            Self::VaultDownload(_) => (FailureKind::Storage, "vault_download_failed"),
        }
    }
}

/// What a verified email code leads to (Electron `ipc/auth-device-handlers.ts:333-339`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpVerified {
    pub is_new_user: bool,
    pub needs_setup: bool,
    pub needs_recovery_input: bool,
    /// Set when the device signed back in as a known device, without the phrase.
    pub device_id: Option<String>,
}

/// The account as the renderer shows it at launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub signed_in: bool,
    pub email: Option<String>,
    pub device_id: Option<String>,
    pub needs_recovery_confirmation: bool,
}

/// A refresh the renderer asked for: `session_ended` only when the server refused the session,
/// never for an offline or waiting refresh (main `9e045ee615`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshOutcome {
    pub success: bool,
    pub session_ended: bool,
}

pub struct AccountService {
    session: Arc<AuthSession>,
    transport: Arc<dyn Transport>,
    base_url: String,
    device: DeviceDescriptor,
    linking: linking::Linking,
    store: Arc<dyn SecureStore>,
    config: Arc<AppConfig>,
    /// Electron's `pendingRecoveryPhrase` (`auth-device-handlers.ts:140`): held in memory only,
    /// until the user confirms it.
    phrase: Mutex<Option<Zeroizing<String>>>,
    /// One key-changing operation at a time: two setups would each mint a master key.
    key_op: tokio::sync::Mutex<()>,
    /// The Google sign-in waiting for its browser (`oauthSessions`, `ipc/auth-oauth-state.ts`).
    oauth: Mutex<Option<oauth::OAuthAttempt>>,
    /// One Google start or Cancel at a time: a start ends the attempt before it.
    oauth_start: tokio::sync::Mutex<()>,
    /// One vault directory refresh at a time, and when the last one read the account's list
    /// (`lastRefreshAt`, `sync/vault-directory.ts:54`).
    directory: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    /// One vault download at a time, from the registry lookup to the registered folder: two
    /// downloads of one vault would both miss the registry and make two folders bound to it.
    downloads: Mutex<()>,
}

/// The core's sign-out marker (#4767), beside `memry-config.json`. Electron writes no such file,
/// so a profile it left restores as before.
pub const SIGN_OUT_MARKER: &str = "memry-signed-out";

impl AccountService {
    /// Builds the app's one session over the keychain and the transport, and restores a session
    /// the keychain still holds.
    pub fn new(
        transport: Arc<dyn Transport>,
        store: Arc<dyn SecureStore>,
        base_url: String,
        device: DeviceDescriptor,
        config: Arc<AppConfig>,
    ) -> Result<Self, ApiError> {
        let session = Arc::new(AuthSession::new(
            transport.clone(),
            store.clone(),
            base_url.clone(),
            "desktop".to_owned(),
            device.clone(),
            Some(
                config
                    .path()
                    .with_file_name(SIGN_OUT_MARKER)
                    .to_string_lossy()
                    .into_owned(),
            ),
        )?);
        let service = Self {
            linking: linking::Linking::new(session.device_approver()),
            session,
            transport,
            base_url,
            device,
            store,
            config,
            phrase: Mutex::new(None),
            key_op: tokio::sync::Mutex::new(()),
            oauth: Mutex::new(None),
            oauth_start: tokio::sync::Mutex::new(()),
            directory: tokio::sync::Mutex::new(None),
            downloads: Mutex::new(()),
        };
        service.restore();
        Ok(service)
    }

    /// The session, for the account calls that need nothing else (devices, vaults, billing).
    pub fn session(&self) -> &AuthSession {
        &self.session
    }

    /// The session shared, for the sync backend of each open vault.
    pub fn shared_session(&self) -> Arc<AuthSession> {
        Arc::clone(&self.session)
    }

    /// A launch probe; a locked keychain leaves the session signed out until the next probe.
    fn restore(&self) {
        if let Err(error) = self.session.restore() {
            tracing::warn!(
                scope = "Account",
                "the session could not be restored: {error}"
            );
        }
    }

    /// `POST /auth/otp/request`, then the code's lifetime in seconds. A sign-in in flight ends
    /// first ([`Self::end_pending_sign_in`]).
    pub async fn request_otp(&self, email: String) -> Result<Option<u64>, AccountError> {
        self.end_pending_sign_in().await?;
        Ok(self.session.request_email_code_answer(email).await?.1)
    }

    /// Before a new sign-in: a code pending for another address ends, a Google attempt ends with
    /// its loopback, and a setup that never registered a device (a failed or expired setup, a
    /// locked keychain) ends; only its setup token goes. A link in flight and a vault choice of
    /// the previous account end too: a choice picked after signing in to another account would
    /// provision and open a vault before its key is refused (VERIFY-4711 Low 1).
    async fn end_pending_sign_in(&self) -> Result<(), AccountError> {
        self.end_oauth_attempt()?;
        self.linking.forget_pending().await;
        match self.session.state() {
            AuthState::AwaitingOtp { .. } => {
                self.session.abandon_email_sign_in()?;
            }
            AuthState::SetupPending | AuthState::SetupExpired => {
                self.session.abandon_setup()?;
            }
            _ => {}
        }
        Ok(())
    }

    pub async fn resend_otp(&self) -> Result<Option<u64>, AccountError> {
        Ok(self.session.resend_email_code_answer().await?)
    }

    /// `POST /auth/otp/verify`, then the known-device path when the server still lists this
    /// device's key (`auth-device-handlers.ts:311-341`). `sync.email` is the address the code was
    /// sent to, which the session holds (`auth-device-handlers.ts:325`).
    pub async fn verify_otp(&self, code: String) -> Result<OtpVerified, AccountError> {
        // The session refuses the code outside `AwaitingOtp`, so `None` never reaches the write.
        let email = match self.session.state() {
            AuthState::AwaitingOtp { email } => Some(email),
            _ => None,
        };
        let (_, answer) = self.session.verify_email_code_answer(code).await?;
        if let Some(email) = email {
            self.write_sync(|sync| {
                sync.insert("email".into(), Value::from(email));
            })?;
        }
        let needs_setup = answer.needs_setup.unwrap_or(false);
        let device_id = if !needs_setup && answer.known_device == Some(true) {
            self.sign_in_known_device().await?
        } else {
            None
        };
        Ok(OtpVerified {
            is_new_user: answer.is_new_user.unwrap_or(false),
            needs_setup,
            needs_recovery_input: !needs_setup && device_id.is_none(),
            device_id,
        })
    }

    /// `AUTH_REFRESH_TOKEN` (`ipc/auth-oauth-handlers.ts:222-229`).
    pub async fn refresh(&self) -> RefreshOutcome {
        match self.session.refresh().await {
            Ok(_) => RefreshOutcome {
                success: true,
                session_ended: false,
            },
            Err(error) => {
                tracing::warn!(scope = "Account", "token refresh failed: {error}");
                RefreshOutcome {
                    success: false,
                    session_ended: self.session.state() == AuthState::SessionExpired,
                }
            }
        }
    }

    /// Signed in is a session **and** the account's master key: a device registered without one
    /// (a setup another device finished first) is still waiting for its phrase. A locked keychain
    /// is not an absent key, so it stays signed in.
    pub fn info(&self) -> AccountInfo {
        self.restore();
        let signed_in = matches!(
            self.session.state(),
            AuthState::Registered | AuthState::Refreshing | AuthState::SessionExpired
        ) && !matches!(self.store.get(SecureStoreKey::MasterKey), Ok(None));
        let (email, device_id, confirmed) = self.sync_fields();
        AccountInfo {
            signed_in,
            email,
            device_id,
            needs_recovery_confirmation: signed_in && confirmed == Some(false),
        }
    }

    /// What the sync gate reads at each start attempt: signed in, and `sync.recoveryPhraseConfirmed`
    /// is not `false`. The master key is the backend's own read.
    pub fn sync_facts(&self) -> (bool, bool) {
        let signed_in = matches!(
            self.session.state(),
            AuthState::Registered | AuthState::Refreshing | AuthState::SessionExpired
        );
        let (_, _, confirmed) = self.sync_fields();
        (signed_in, confirmed != Some(false))
    }

    /// The access token when the user is signed in, for feedback and the beta invite; `None`
    /// signed out or when it cannot be read (`ipc/feedback-handlers.ts:23-27`).
    pub async fn access_token_if_signed_in(&self) -> Option<String> {
        match self.session.valid_access_token().await {
            Ok(token) => token,
            Err(error) => {
                tracing::warn!(
                    scope = "Account",
                    "no access token for the request: {error}"
                );
                None
            }
        }
    }

    /// `sync.email`, `sync.deviceId` and `sync.recoveryPhraseConfirmed`.
    fn sync_fields(&self) -> (Option<String>, Option<String>, Option<bool>) {
        self.config.read(|config| {
            let sync = config.get("sync");
            let text = |key: &str| sync.and_then(|s| s.get(key)).and_then(Value::as_str);
            (
                text("email").map(str::to_owned),
                text("deviceId").map(str::to_owned),
                sync.and_then(|s| s.get("recoveryPhraseConfirmed"))
                    .and_then(Value::as_bool),
            )
        })
    }

    /// Writes into `memry-config.json` `sync`, keeping every key another build wrote.
    fn write_sync(&self, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), ConfigError> {
        self.config.update(|config| {
            let sync = config
                .entry("sync")
                .or_insert_with(|| Value::Object(Map::new()));
            if !sync.is_object() {
                *sync = Value::Object(Map::new());
            }
            if let Value::Object(map) = sync {
                f(map);
            }
            Ok::<_, ConfigError>(())
        })
    }
}
