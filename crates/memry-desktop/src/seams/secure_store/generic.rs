//! Raw secrets for the services that are not the five sync entries (AI provider keys, OAuth
//! tokens of calendar and Readwise, and so on). Steps 22, 24, 27 and 29 use this and add no
//! keychain code of their own.

use memry_core::api::errors::SecureStoreError;

use super::worker::{Op, Reply};
use super::{IDENTITY_SERVICE, KeyringStore, SERVICE};

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

/// The sync secrets and the device identity have owners of their own ([`KeyringStore`]'s
/// `SecureStore` and [`super::DeviceIdentityStore`]); a generic caller reaching them would bypass
/// their format, the device key's cache and the rule that Electron's items are never written.
fn closed(service: &str) -> Result<(), SecureStoreError> {
    if service == SERVICE || service == IDENTITY_SERVICE {
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
