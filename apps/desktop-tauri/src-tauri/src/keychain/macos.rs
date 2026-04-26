//! macOS Keychain backend backed by `security-framework`'s generic password
//! API. Maps `errSecItemNotFound` to `Ok(None)` for `get_item` and `Ok(())`
//! for `delete_item`. `set_item` deletes any existing item first to avoid
//! `errSecDuplicateItem` on overwrite, matching the trait contract used by
//! the in-memory backend.

use security_framework::base::Error as SfError;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

use crate::error::{AppError, AppResult};
use crate::keychain::service::KeychainStore;

/// `errSecItemNotFound` from `<Security/SecBase.h>`.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Default)]
pub struct MacosKeychain;

impl MacosKeychain {
    pub fn new() -> Self {
        Self
    }
}

fn is_not_found(err: &SfError) -> bool {
    err.code() == ERR_SEC_ITEM_NOT_FOUND
}

impl KeychainStore for MacosKeychain {
    fn set_item(&self, service: &str, account: &str, value: &[u8]) -> AppResult<()> {
        match delete_generic_password(service, account) {
            Ok(()) => {}
            Err(err) if is_not_found(&err) => {}
            Err(err) => {
                return Err(AppError::Keychain(format!(
                    "delete-before-set failed: {err}"
                )));
            }
        }
        set_generic_password(service, account, value)
            .map_err(|err| AppError::Keychain(format!("set failed: {err}")))
    }

    fn get_item(&self, service: &str, account: &str) -> AppResult<Option<Vec<u8>>> {
        match get_generic_password(service, account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(AppError::Keychain(format!("get failed: {err}"))),
        }
    }

    fn delete_item(&self, service: &str, account: &str) -> AppResult<()> {
        match delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(AppError::Keychain(format!("delete failed: {err}"))),
        }
    }
}
