//! The signed-in account on this install: email sign-in, first-device setup, the recovery phrase
//! and the known-device path, over the one `AuthSession` the app builds (Step 19, #3536).
//!
//! The session owns the auth machine, the tokens and the device key; this service owns what
//! Electron kept beside them: the `sync` section of `memry-config.json` (`email`, `deviceId`,
//! `accountKeyVerifier`, `recoveryPhraseConfirmed`, Electron's names and types, which Step 37
//! imports), the master key write, and the phrase shown once after setup. Sync is not started
//! here: the master key lands in the keychain and the sync supervisor picks it up (A4).

pub mod device;
pub mod otp_clipboard;
mod recovery;

use std::sync::{Arc, Mutex};

use memry_core::api::auth::{AuthSession, AuthState, DeviceDescriptor};
use memry_core::api::errors::{ApiError, AuthError, SecureStoreError};
use memry_core::seams::secure_store::SecureStore;
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
    session: AuthSession,
    store: Arc<dyn SecureStore>,
    config: Arc<AppConfig>,
    /// Electron's `pendingRecoveryPhrase` (`auth-device-handlers.ts:140`): held in memory only,
    /// until the user confirms it.
    phrase: Mutex<Option<Zeroizing<String>>>,
    /// One key-changing operation at a time: two setups would each mint a master key.
    key_op: tokio::sync::Mutex<()>,
}

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
        let session = AuthSession::new(
            transport,
            store.clone(),
            base_url,
            "desktop".to_owned(),
            device,
        )?;
        let service = Self {
            session,
            store,
            config,
            phrase: Mutex::new(None),
            key_op: tokio::sync::Mutex::new(()),
        };
        service.restore();
        Ok(service)
    }

    /// The session, for the account calls that need nothing else (devices, vaults, billing).
    pub fn session(&self) -> &AuthSession {
        &self.session
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

    /// `POST /auth/otp/request`. A code already pending for another address ends first.
    pub async fn request_otp(&self, email: String) -> Result<(), AccountError> {
        if matches!(self.session.state(), AuthState::AwaitingOtp { .. }) {
            self.session.abandon_email_sign_in()?;
        }
        self.session.request_email_code(email).await?;
        Ok(())
    }

    pub async fn resend_otp(&self) -> Result<(), AccountError> {
        Ok(self.session.resend_email_code().await?)
    }

    /// `POST /auth/otp/verify`, then the known-device path when the server still lists this
    /// device's key (`auth-device-handlers.ts:311-341`).
    pub async fn verify_otp(&self, email: &str, code: String) -> Result<OtpVerified, AccountError> {
        let (_, answer) = self.session.verify_email_code_answer(code).await?;
        self.write_sync(|sync| {
            sync.insert("email".into(), Value::from(email));
        })?;
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

    pub fn info(&self) -> AccountInfo {
        self.restore();
        let signed_in = matches!(
            self.session.state(),
            AuthState::Registered | AuthState::Refreshing | AuthState::SessionExpired
        );
        let (email, device_id, confirmed) = self.config.read(|config| {
            let sync = config.get("sync");
            let text = |key: &str| sync.and_then(|s| s.get(key)).and_then(Value::as_str);
            (
                text("email").map(str::to_owned),
                text("deviceId").map(str::to_owned),
                sync.and_then(|s| s.get("recoveryPhraseConfirmed"))
                    .and_then(Value::as_bool),
            )
        });
        AccountInfo {
            signed_in,
            email,
            device_id,
            needs_recovery_confirmation: signed_in && confirmed == Some(false),
        }
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
