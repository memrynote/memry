//! Where Chromium's OSCrypt key material comes from. The real OS readers (Keychain, DPAPI,
//! Secret Service, KWallet) implement [`ChromiumKeySource`]; none of them may create, modify or
//! delete an item. [`FixedKeySource`] serves recorded values in tests.

use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::electron_import::profile::ElectronProfile;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeySourceError {
    /// The user (or policy) refused the prompt.
    #[error("access to the key was denied")]
    Denied,
    #[error("key source failed: {0}")]
    Failed(String),
}

pub trait ChromiumKeySource {
    /// macOS keychain password or Linux libsecret/KWallet password stored for `app_name`.
    /// `Ok(None)` when no such item exists. Never creates one.
    fn password(&self, app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError>;

    /// Windows: the unwrapped 32-byte AES key from `Local State`.
    fn windows_key(
        &self,
        profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError>;
}

/// Recorded key material for tests.
#[derive(Default)]
pub struct FixedKeySource {
    pub passwords: BTreeMap<String, Vec<u8>>,
    pub windows_key: Option<[u8; 32]>,
    pub denied: bool,
}

impl ChromiumKeySource for FixedKeySource {
    fn password(&self, app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        if self.denied {
            return Err(KeySourceError::Denied);
        }
        Ok(self.passwords.get(app_name).cloned().map(Zeroizing::new))
    }

    fn windows_key(
        &self,
        _profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        if self.denied {
            return Err(KeySourceError::Denied);
        }
        Ok(self.windows_key.map(Zeroizing::new))
    }
}
