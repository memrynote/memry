//! Per-provider calendar credentials (`calendar/provider/secrets.ts`, #1394): each provider's
//! secrets live under the service `com.memrynote.memry.calendar.<providerId>`, keyed
//! `<kind>-<accountId>` plus `-<MEMRY_DEVICE>` for multi-profile runs. They never sync.
//!
//! Electron's service was `com.memry.calendar.<providerId>`; those entries are Step 37's import
//! material (#3554) and are never read here, so an account without a token here shows Reconnect.

use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use zeroize::Zeroizing;

use crate::seams::secure_store::GenericSecrets;

const SERVICE_PREFIX: &str = "com.memrynote.memry.calendar.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    AccessToken,
    RefreshToken,
    Password,
}

impl SecretKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AccessToken => "access-token",
            Self::RefreshToken => "refresh-token",
            Self::Password => "password",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("invalid calendar provider id for secret storage: {0}")]
    InvalidProvider(String),
    #[error("a calendar credential needs a non-empty account id")]
    EmptyAccount,
    #[error(transparent)]
    Store(#[from] SecureStoreError),
}

/// `providerSecretService`: only `[a-z0-9-]+` names a provider.
pub fn service(provider_id: &str) -> Result<String, CredentialError> {
    let valid = !provider_id.is_empty()
        && provider_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err(CredentialError::InvalidProvider(provider_id.to_owned()));
    }
    Ok(format!("{SERVICE_PREFIX}{provider_id}"))
}

pub struct ProviderCredentials {
    secrets: Arc<dyn GenericSecrets>,
    /// The `MEMRY_DEVICE` value; an empty one adds no suffix, as in Electron.
    device: Option<String>,
}

impl ProviderCredentials {
    pub fn new(secrets: Arc<dyn GenericSecrets>, device: Option<String>) -> Self {
        Self {
            secrets,
            device: device.filter(|d| !d.is_empty()),
        }
    }

    /// `providerSecretAccountKey`.
    pub fn account_key(
        &self,
        account_id: &str,
        kind: SecretKind,
    ) -> Result<String, CredentialError> {
        if account_id.trim().is_empty() {
            return Err(CredentialError::EmptyAccount);
        }
        let base = format!("{}-{account_id}", kind.as_str());
        Ok(match &self.device {
            Some(device) => format!("{base}-{device}"),
            None => base,
        })
    }

    /// `getProviderSecret`: an entry this device cannot read (a locked or failing store, or bytes
    /// that are not text) reads as absent, so a connect flow can always replace it (#1151).
    pub fn get(
        &self,
        provider_id: &str,
        account_id: &str,
        kind: SecretKind,
    ) -> Result<Option<Zeroizing<String>>, CredentialError> {
        let service = service(provider_id)?;
        let account = self.account_key(account_id, kind)?;
        match self.secrets.get_secret(&service, &account) {
            Ok(None) => Ok(None),
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(text) => Ok(Some(Zeroizing::new(text))),
                Err(error) => {
                    drop(Zeroizing::new(error.into_bytes()));
                    tracing::warn!(
                        scope = "calendar_credentials",
                        service,
                        account,
                        "a calendar secret is not text; treating it as absent"
                    );
                    Ok(None)
                }
            },
            Err(error @ (SecureStoreError::Locked | SecureStoreError::Failed { .. })) => {
                tracing::warn!(
                    scope = "calendar_credentials",
                    service,
                    account,
                    "a calendar secret is unreadable ({error}); treating it as absent"
                );
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// `setProviderSecret`: stores `value` (trimmed, except a password), or deletes the entry
    /// when it is absent or blank.
    pub fn set(
        &self,
        provider_id: &str,
        account_id: &str,
        kind: SecretKind,
        value: Option<&str>,
    ) -> Result<(), CredentialError> {
        let service = service(provider_id)?;
        let account = self.account_key(account_id, kind)?;
        match value.filter(|v| !v.trim().is_empty()) {
            None => self.secrets.delete_secret(&service, &account)?,
            Some(value) => {
                let value = if kind == SecretKind::Password {
                    value
                } else {
                    value.trim()
                };
                self.secrets
                    .set_secret(&service, &account, value.as_bytes())?;
            }
        }
        Ok(())
    }

    pub fn delete(
        &self,
        provider_id: &str,
        account_id: &str,
        kind: SecretKind,
    ) -> Result<(), CredentialError> {
        let service = service(provider_id)?;
        let account = self.account_key(account_id, kind)?;
        Ok(self.secrets.delete_secret(&service, &account)?)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// A store that answers each (service, account) with what was set, or with `fail`.
    #[derive(Default)]
    struct Fake {
        entries: Mutex<HashMap<(String, String), Vec<u8>>>,
        fail: Mutex<Option<SecureStoreError>>,
    }

    impl Fake {
        fn failing(error: SecureStoreError) -> Arc<Self> {
            let fake = Self::default();
            *fake.fail.lock().unwrap() = Some(error);
            Arc::new(fake)
        }

        fn raw(&self, service: &str, account: &str) -> Option<Vec<u8>> {
            self.entries
                .lock()
                .unwrap()
                .get(&(service.to_owned(), account.to_owned()))
                .cloned()
        }
    }

    impl GenericSecrets for Fake {
        fn get_secret(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Option<Vec<u8>>, SecureStoreError> {
            if let Some(error) = self.fail.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(self.raw(service, account))
        }

        fn set_secret(
            &self,
            service: &str,
            account: &str,
            value: &[u8],
        ) -> Result<(), SecureStoreError> {
            self.entries
                .lock()
                .unwrap()
                .insert((service.to_owned(), account.to_owned()), value.to_vec());
            Ok(())
        }

        fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
            self.entries
                .lock()
                .unwrap()
                .remove(&(service.to_owned(), account.to_owned()));
            Ok(())
        }
    }

    #[test]
    fn the_service_is_per_provider_and_refuses_other_names() {
        assert_eq!(
            service("google").unwrap(),
            "com.memrynote.memry.calendar.google"
        );
        assert_eq!(
            service("caldav-2").unwrap(),
            "com.memrynote.memry.calendar.caldav-2"
        );
        for bad in ["", "Google", "a.b", "a/b", "ü"] {
            assert!(
                matches!(service(bad), Err(CredentialError::InvalidProvider(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_account_key_is_kind_then_account_then_device() {
        let fake: Arc<dyn GenericSecrets> = Arc::new(Fake::default());
        let plain = ProviderCredentials::new(fake.clone(), None);
        assert_eq!(
            plain.account_key("acc", SecretKind::RefreshToken).unwrap(),
            "refresh-token-acc"
        );
        let empty_device = ProviderCredentials::new(fake.clone(), Some(String::new()));
        assert_eq!(
            empty_device
                .account_key("acc", SecretKind::Password)
                .unwrap(),
            "password-acc"
        );
        let device = ProviderCredentials::new(fake, Some("b".into()));
        assert_eq!(
            device.account_key("acc", SecretKind::AccessToken).unwrap(),
            "access-token-acc-b"
        );
        assert!(matches!(
            device.account_key("  ", SecretKind::AccessToken),
            Err(CredentialError::EmptyAccount)
        ));
    }

    #[test]
    fn set_trims_tokens_keeps_passwords_and_blank_deletes() {
        let fake = Arc::new(Fake::default());
        let creds = ProviderCredentials::new(fake.clone(), None);
        creds
            .set("google", "a", SecretKind::AccessToken, Some(" tok \n"))
            .unwrap();
        creds
            .set("caldav", "a", SecretKind::Password, Some(" pw "))
            .unwrap();
        assert_eq!(
            fake.raw("com.memrynote.memry.calendar.google", "access-token-a"),
            Some(b"tok".to_vec())
        );
        assert_eq!(
            creds
                .get("caldav", "a", SecretKind::Password)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some(" pw ")
        );
        creds
            .set("google", "a", SecretKind::AccessToken, Some("   "))
            .unwrap();
        assert_eq!(
            fake.raw("com.memrynote.memry.calendar.google", "access-token-a"),
            None
        );
        creds
            .set("caldav", "a", SecretKind::Password, None)
            .unwrap();
        assert!(
            creds
                .get("caldav", "a", SecretKind::Password)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_unreadable_entry_reads_as_absent() {
        for error in [
            SecureStoreError::Locked,
            SecureStoreError::Failed {
                what: "decrypt".into(),
            },
        ] {
            let creds = ProviderCredentials::new(Fake::failing(error.clone()), None);
            assert!(
                creds
                    .get("google", "a", SecretKind::RefreshToken)
                    .unwrap()
                    .is_none(),
                "{error:?}"
            );
        }
        let fake = Arc::new(Fake::default());
        fake.set_secret(
            "com.memrynote.memry.calendar.google",
            "refresh-token-a",
            &[0xff, 0xfe],
        )
        .unwrap();
        let creds = ProviderCredentials::new(fake, None);
        assert!(
            creds
                .get("google", "a", SecretKind::RefreshToken)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_refused_service_is_an_error_not_absent() {
        let creds = ProviderCredentials::new(
            Fake::failing(SecureStoreError::Denied {
                what: "closed".into(),
            }),
            None,
        );
        assert!(matches!(
            creds.get("google", "a", SecretKind::RefreshToken),
            Err(CredentialError::Store(SecureStoreError::Denied { .. }))
        ));
    }
}
