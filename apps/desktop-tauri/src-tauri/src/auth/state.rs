//! `AuthRuntime` owns in-memory unlock state plus a handle to the
//! `KeychainStore`. Master and vault keys are wrapped in
//! `zeroize::Zeroizing<Vec<u8>>` so that drops scrub the bytes; `lock` and
//! `fail_unlock` clear those slots explicitly.
//!
//! State machine:
//!
//! ```text
//! Locked --begin_unlock-->  Unlocking
//! Unlocking --finish_unlock--> Unlocked
//! Unlocking --fail_unlock--> Error
//! Unlocked --lock--> Locked
//! Error --begin_unlock--> Unlocking
//! ```
//!
//! Errors recorded via `fail_unlock` are run through a placeholder redactor
//! before storage; Phase C (Task 10) replaces this with the canonical
//! PII-safe redaction helper.

use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use crate::auth::types::{AuthStateKind, AuthStatus};
use crate::error::AppResult;
use crate::keychain::KeychainStore;

/// Materialised session passed in once an unlock attempt succeeds. The two
/// key fields take ownership of bytes; the runtime moves them into
/// `Zeroizing` slots so that any subsequent drop scrubs the memory.
#[derive(Debug, Clone)]
pub struct UnlockedSession {
    pub device_id: String,
    pub email: Option<String>,
    pub has_biometric: bool,
    pub remember_device: bool,
    pub master_key: Vec<u8>,
    pub vault_key: Vec<u8>,
}

pub struct AuthRuntime {
    inner: Mutex<AuthInner>,
    keychain: Arc<dyn KeychainStore>,
}

struct AuthInner {
    state: AuthStateKind,
    device_id: Option<String>,
    email: Option<String>,
    has_biometric: bool,
    remember_device: bool,
    error: Option<String>,
    master_key: Option<Zeroizing<Vec<u8>>>,
    vault_key: Option<Zeroizing<Vec<u8>>>,
}

impl AuthInner {
    fn default_locked() -> Self {
        Self {
            state: AuthStateKind::Locked,
            device_id: None,
            email: None,
            has_biometric: false,
            remember_device: false,
            error: None,
            master_key: None,
            vault_key: None,
        }
    }
}

impl AuthRuntime {
    pub fn new(keychain: Arc<dyn KeychainStore>) -> Self {
        Self {
            inner: Mutex::new(AuthInner::default_locked()),
            keychain,
        }
    }

    pub fn keychain(&self) -> Arc<dyn KeychainStore> {
        Arc::clone(&self.keychain)
    }

    pub fn status(&self) -> AuthStatus {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        AuthStatus {
            state: g.state.clone(),
            device_id: g.device_id.clone(),
            email: g.email.clone(),
            has_biometric: g.has_biometric,
            remember_device: g.remember_device,
        }
    }

    pub fn last_error_message(&self) -> Option<String> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.error.clone()
    }

    pub fn begin_unlock(&self) -> AppResult<()> {
        let mut g = self.inner.lock()?;
        g.state = AuthStateKind::Unlocking;
        g.error = None;
        Ok(())
    }

    pub fn finish_unlock(&self, session: UnlockedSession) -> AppResult<()> {
        let mut g = self.inner.lock()?;
        g.state = AuthStateKind::Unlocked;
        g.device_id = Some(session.device_id);
        g.email = session.email;
        g.has_biometric = session.has_biometric;
        g.remember_device = session.remember_device;
        g.error = None;
        g.master_key = Some(Zeroizing::new(session.master_key));
        g.vault_key = Some(Zeroizing::new(session.vault_key));
        Ok(())
    }

    pub fn fail_unlock(&self, raw_message: impl AsRef<str>) -> AppResult<()> {
        let redacted = redact_state_error(raw_message.as_ref());
        let mut g = self.inner.lock()?;
        g.state = AuthStateKind::Error;
        g.error = Some(redacted);
        g.master_key = None;
        g.vault_key = None;
        Ok(())
    }

    pub fn lock(&self) -> AppResult<()> {
        let mut g = self.inner.lock()?;
        g.state = AuthStateKind::Locked;
        g.error = None;
        g.master_key = None;
        g.vault_key = None;
        Ok(())
    }

    pub fn master_key_clone(&self) -> Option<Vec<u8>> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.master_key.as_ref().map(|k| k.to_vec())
    }

    pub fn vault_key_clone(&self) -> Option<Vec<u8>> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.vault_key.as_ref().map(|k| k.to_vec())
    }
}

/// Phase B placeholder. Phase C (Task 10) ships the canonical PII-safe
/// redaction helper. Until then, callers receive a stable, opaque category
/// string so password bytes / tokens / OTPs cannot reach the IPC surface
/// through `last_error_message()`.
fn redact_state_error(_raw: &str) -> String {
    "auth_error".to_string()
}
