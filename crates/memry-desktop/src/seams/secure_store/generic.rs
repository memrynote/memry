//! Raw secrets for the services that are not the five sync entries (AI provider keys, OAuth
//! tokens of calendar and Readwise, and so on). Steps 22, 24, 27 and 29 use this and add no
//! keychain code of their own.

use memry_core::api::errors::SecureStoreError;

use super::KeyringStore;
use super::worker::Op;

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

impl GenericSecrets for KeyringStore {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        let reply = self.worker.call(service, account, Op::Get)?;
        Ok(reply.map(|bytes| bytes.to_vec()))
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.worker
            .call(
                service,
                account,
                Op::Set(zeroize::Zeroizing::new(value.to_vec())),
            )
            .map(|_| ())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.worker.call(service, account, Op::Delete).map(|_| ())
    }
}
