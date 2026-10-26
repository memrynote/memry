//! macOS Keychain readers: Chromium's Safe Storage password and legacy keytar items.
//!
//! Read-only: only `SecItemCopyMatching` is used. Nothing here adds, updates or deletes an item.
//! Reading another app's item shows the Keychain prompt once; "Always Allow" makes later reads
//! silent because the Electron app and this one share a bundle id and Team ID.

use security_framework::base::Error as SecError;
use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{PasswordOptions, generic_password};
use zeroize::Zeroizing;

use super::key_source::{ChromiumKeySource, KeySourceError};
use super::keytar::{KeytarSource, is_keytar_service};
use crate::electron_import::profile::ElectronProfile;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// `Ok(None)` for a missing item, [`KeySourceError::Denied`] for a refused prompt.
fn read_item(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
    match generic_password(PasswordOptions::new_generic_password(service, account)) {
        Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
        Err(error) => classify(&error),
    }
}

fn classify<T>(error: &SecError) -> Result<Option<T>, KeySourceError> {
    match error.code() {
        ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED => {
            Err(KeySourceError::Denied)
        }
        code => Err(KeySourceError::Failed(format!("Keychain error {code}"))),
    }
}

/// Reads `<name> Safe Storage` / `<name> Key`, then the legacy account `<name>` that Chromium
/// migrates from.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeySource;

impl ChromiumKeySource for OsKeySource {
    fn password(&self, app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        let service = format!("{app_name} Safe Storage");
        if let Some(found) = read_item(&service, &format!("{app_name} Key"))? {
            return Ok(Some(found));
        }
        read_item(&service, app_name)
    }

    fn windows_key(
        &self,
        _profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

/// Legacy keytar generic passwords: attributes first, data second. The listing loads attributes
/// only, which shows no prompt; data is read for the services the app wrote.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeytar;

impl KeytarSource for OsKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        let found = match found {
            Ok(found) => found,
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => return Ok(Vec::new()),
            Err(error) => {
                return Err(KeySourceError::Failed(format!(
                    "Keychain listing error {}",
                    error.code()
                )));
            }
        };
        Ok(found
            .iter()
            .filter_map(|entry| {
                let attrs = entry.simplify_dict()?;
                let (service, account) = (attrs.get("svce")?, attrs.get("acct")?);
                is_keytar_service(service).then(|| (service.clone(), account.clone()))
            })
            .collect())
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        // keytar wrote UTF-8 text. A non-UTF-8 blob is not one of its items.
        Ok(read_item(service, account)?
            .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
            .map(Zeroizing::new))
    }
}
