use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::{SecretsError, kind};
use crate::seams::secure_store::{GenericSecrets, KeyringStore};

pub(super) enum Written {
    Sync(SecureStoreKey),
    Generic { service: String, account: String },
}

/// What this run wrote, deleted again in reverse on a failure.
#[derive(Default)]
pub(super) struct Ledger(pub(super) Vec<Written>);

impl Ledger {
    pub(super) fn roll_back(self, keyring: &KeyringStore, cause: SecretsError) -> SecretsError {
        let mut left = 0;
        for written in self.0.into_iter().rev() {
            let result = match &written {
                Written::Sync(key) => keyring.delete(*key),
                Written::Generic { service, account } => keyring.delete_secret(service, account),
            };
            if let Err(error) = result {
                left += 1;
                let what = match &written {
                    Written::Sync(key) => kind(*key).to_owned(),
                    Written::Generic { service, .. } => service.clone(),
                };
                tracing::warn!(
                    scope = "ElectronImport",
                    "the rollback could not remove the {what} this run wrote: {error}"
                );
            }
        }
        if left == 0 {
            cause
        } else {
            SecretsError::RollbackIncomplete {
                cause: Box::new(cause),
                left,
            }
        }
    }
}
