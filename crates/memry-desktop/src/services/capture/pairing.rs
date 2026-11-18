//! Extension pairing (`apps/desktop/src/main/capture/pairing.ts` and the consent bookkeeping of
//! `server.ts:33-37`): the token in the keychain, the allowlisted origins in
//! `memry-config.json`, the claim window and the per-origin consent state.
//!
//! Storage contract (the Electron entries are imported by Step 37, #3554): the token is 32
//! random bytes as hex under service [`SERVICE`], account [`ACCOUNT`] (with the `MEMRY_DEVICE`
//! suffix rule); the allowlist is the string array [`ALLOWLIST_KEY`], written through
//! `AppConfig::update`, which keeps every other key.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use serde_json::Value;
use zeroize::Zeroizing;

use super::auth::is_extension_origin;
use crate::registry::{AppConfig, ConfigError};
use crate::seams::secure_store::{GenericSecrets, device_account};

pub const SERVICE: &str = "com.memrynote.memry.capture";
pub const ACCOUNT: &str = "pairing-token";
pub const ALLOWLIST_KEY: &str = "captureAllowedOrigins";
/// `openPairingWindow(ttlMs = 120_000)`.
pub const CLAIM_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum PairError {
    #[error("capture token: {0}")]
    Keychain(#[from] SecureStoreError),
    #[error("capture allowlist: {0}")]
    Config(#[from] ConfigError),
}

pub struct Pairing {
    secrets: Arc<dyn GenericSecrets>,
    account: String,
    config: Arc<AppConfig>,
    /// The token once read or minted, so `/capture` costs no keychain call (`pairing.ts:18-21`).
    /// Held across the keychain call, so two first readers cannot mint two tokens.
    token: Mutex<Option<Zeroizing<String>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    window: Option<ClaimWindow>,
    pending: HashSet<String>,
    denied: HashSet<String>,
}

struct ClaimWindow {
    until: Instant,
    /// The origin the window was opened for; `None` (the `pair` deep link) admits any
    /// extension origin.
    origin: Option<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Pairing {
    /// `device` is the `MEMRY_DEVICE` value (the `-<device>` account suffix).
    pub fn new(
        secrets: Arc<dyn GenericSecrets>,
        device: Option<&str>,
        config: Arc<AppConfig>,
    ) -> Self {
        Self {
            secrets,
            account: device_account(ACCOUNT, device),
            config,
            token: Mutex::new(None),
            state: Mutex::new(State::default()),
        }
    }

    /// `getCaptureToken`: the stored token, else a new one stored first. A stored value that is
    /// not non-empty UTF-8 counts as absent and is replaced (`treatUnreadableAsAbsent`,
    /// `pairing.ts:26-29`). A keychain that cannot be reached is an error and mints nothing:
    /// replacing a token that is only locked would unpair every extension. Blocking.
    pub fn token(&self) -> Result<Zeroizing<String>, SecureStoreError> {
        let mut cached = lock(&self.token);
        if let Some(token) = cached.as_ref() {
            return Ok(token.clone());
        }
        let stored = self
            .secrets
            .get_secret(SERVICE, &self.account)?
            .map(Zeroizing::new)
            .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
            .filter(|text| !text.is_empty())
            .map(Zeroizing::new);
        let token = match stored {
            Some(token) => token,
            None => {
                let token = Zeroizing::new(hex::encode(Zeroizing::new(sodium::random_bytes(32))));
                self.secrets
                    .set_secret(SERVICE, &self.account, token.as_bytes())?;
                token
            }
        };
        *cached = Some(token.clone());
        Ok(token)
    }

    /// `isOriginAllowed`.
    pub fn is_allowed(&self, origin: Option<&str>) -> bool {
        let Some(origin) = origin else {
            return false;
        };
        self.config.read(|config| {
            config
                .get(ALLOWLIST_KEY)
                .and_then(Value::as_array)
                .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(origin)))
        })
    }

    /// `openPairingWindow`, for the `pair` deep link after its confirm dialog: any extension
    /// origin may claim within [`CLAIM_WINDOW`].
    pub fn open_window(&self) {
        self.open_window_for(None, CLAIM_WINDOW);
    }

    /// A claim window for `origin` only (`None`: any extension origin) that closes after `ttl`.
    pub fn open_window_for(&self, origin: Option<&str>, ttl: Duration) {
        lock(&self.state).window = Some(ClaimWindow {
            until: Instant::now() + ttl,
            origin: origin.map(str::to_owned),
        });
    }

    /// `claimPairing`: within an open window, `origin` joins the allowlist and gets the token,
    /// and the window closes (one claim per window). `Ok(None)` when no window admits it.
    pub fn claim(&self, origin: &str) -> Result<Option<Zeroizing<String>>, PairError> {
        {
            let mut state = lock(&self.state);
            let admitted = state.window.as_ref().is_some_and(|window| {
                Instant::now() < window.until
                    && window.origin.as_deref().is_none_or(|o| o == origin)
            });
            if !admitted || !is_extension_origin(origin) {
                return Ok(None);
            }
            state.window = None;
        }
        let token = self.token()?;
        self.config.update(|config| {
            let list = match config.get_mut(ALLOWLIST_KEY) {
                Some(Value::Array(list)) => list,
                _ => {
                    config.insert(ALLOWLIST_KEY.to_owned(), Value::Array(Vec::new()));
                    match config.get_mut(ALLOWLIST_KEY) {
                        Some(Value::Array(list)) => list,
                        _ => unreachable!("inserted above"),
                    }
                }
            };
            if !list.iter().any(|v| v.as_str() == Some(origin)) {
                list.push(Value::String(origin.to_owned()));
            }
            Ok::<_, ConfigError>(())
        })?;
        Ok(Some(token))
    }

    /// `unpairCapture`: the token deleted, every origin unpaired, the window closed.
    pub fn unpair(&self) -> Result<(), PairError> {
        let mut cached = lock(&self.token);
        self.secrets.delete_secret(SERVICE, &self.account)?;
        *cached = None;
        drop(cached);
        self.config.update(|config| {
            config.insert(ALLOWLIST_KEY.to_owned(), Value::Array(Vec::new()));
            Ok::<_, ConfigError>(())
        })?;
        lock(&self.state).window = None;
        Ok(())
    }

    /// A consent prompt for `origin` may start: `false` while one is already showing for it.
    /// A new prompt forgets an earlier denial (`server.ts:143-146`).
    pub fn begin_consent(&self, origin: &str) -> bool {
        let mut state = lock(&self.state);
        if !state.pending.insert(origin.to_owned()) {
            return false;
        }
        state.denied.remove(origin);
        true
    }

    /// The prompt for `origin` was answered: Allow opens its claim window, Deny marks it so the
    /// next claim reports `pair-denied` (`server.ts:147-151`).
    pub fn finish_consent(&self, origin: &str, allowed: bool) {
        lock(&self.state).pending.remove(origin);
        if allowed {
            self.open_window_for(Some(origin), CLAIM_WINDOW);
        } else {
            lock(&self.state).denied.insert(origin.to_owned());
        }
    }

    /// Whether `origin` was denied, clearing the mark (`server.ts:112`).
    pub fn take_denied(&self, origin: &str) -> bool {
        lock(&self.state).denied.remove(origin)
    }
}
