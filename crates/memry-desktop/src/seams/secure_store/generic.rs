//! Raw secrets for the services that are not the five sync entries (AI provider keys, OAuth
//! tokens of calendar and Readwise, and so on), each under a service `com.memrynote.memry.<feature>`.
//! Steps 22, 24, 27 and 29 use this and add no keychain code of their own.

use memry_core::api::errors::SecureStoreError;

use super::worker::{Op, Reply};
use super::{KeyringStore, SERVICE};

/// A secret under any (service, account). The value is the raw bytes, with no base64 layer (only
/// the five `SecureStoreKey` entries use the base64 text format). The Windows credential target
/// is `<service>/<account>` for every service. Same worker thread, deadline, latch and error
/// mapping as [`KeyringStore`]: an unreadable secret is `Locked`, never absent.
pub trait GenericSecrets: Send + Sync {
    fn get_secret(&self, service: &str, account: &str)
    -> Result<Option<Vec<u8>>, SecureStoreError>;
    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError>;
    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError>;
}

/// Closed services. This app's own service [`SERVICE`] has owners ([`KeyringStore`]'s
/// `SecureStore` and [`super::DeviceIdentityStore`]): a generic caller would bypass their format
/// and the device key's cache. Every Electron service (`com.memry.*`, `memry.*`) is read-only import material for Step 37 (#3554): Electron's `getSecret` and `setSecret`
/// move each keychain item into its own file and delete the keychain copy (see [`SERVICE`]).
/// Generic secrets live under
/// `com.memrynote.memry.<feature>`. Case-insensitive: the macOS and Windows stores match names
/// without regard to case.
fn closed(service: &str) -> Result<(), SecureStoreError> {
    let service_lower = service.to_ascii_lowercase();
    let electron = service_lower.starts_with("com.memry.") || service_lower.starts_with("memry.");
    if electron || service_lower == SERVICE {
        return Err(SecureStoreError::Denied {
            what: format!("the keychain service `{service}` is not open to generic secrets"),
        });
    }
    Ok(())
}

impl KeyringStore {
    /// The raw path under any service, for the owners of the closed ones.
    pub(crate) fn raw(&self, service: &str, account: &str, op: Op) -> Reply {
        self.worker.call(service, account, op)
    }
}

impl GenericSecrets for KeyringStore {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        closed(service)?;
        let reply = self.raw(service, account, Op::Get)?;
        Ok(reply.map(|bytes| bytes.to_vec()))
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        closed(service)?;
        self.raw(
            service,
            account,
            Op::Set(zeroize::Zeroizing::new(value.to_vec())),
        )
        .map(|_| ())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        closed(service)?;
        self.raw(service, account, Op::Delete).map(|_| ())
    }
}
