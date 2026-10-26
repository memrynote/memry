//! Linux readers: Chromium's libsecret or KWallet password and legacy keytar items.
//!
//! Read-only. Secret Service: connect (the bus may D-Bus-activate the keyring daemon, as any
//! client's connect does; this code never starts one itself), search by attributes, unlock a locked item (the service
//! prompts the user), read its secret. KWallet: `isEnabled`, `networkWallet`, `open`, `hasEntry`,
//! `readPassword`, `close`. Neither path ever stores a password, writes an entry or creates a
//! collection, wallet or folder: Chromium mints a key when none exists and this code must not.

use std::collections::HashMap;

use secret_service::blocking::{Item, SecretService};
use secret_service::{EncryptionType, Error as SsError};
use zbus::blocking::{Connection, Proxy, fdo::DBusProxy};
use zeroize::Zeroizing;

use super::key_source::{ChromiumKeySource, KeySourceError};
use super::keytar::{KeytarSource, is_keytar_service};
use crate::electron_import::profile::ElectronProfile;

const SCHEMA_ATTR: &str = "xdg:schema";
const CHROMIUM_SCHEMA_V2: &str = "chrome_libsecret_os_crypt_password_v2";
/// Chromium's schema before v2; it migrates from it when the v2 item is absent.
const CHROMIUM_SCHEMA_V1: &str = "chrome_libsecret_os_crypt_password";
const GENERIC_SCHEMA: &str = "org.freedesktop.Secret.Generic";
const KWALLET_FOLDER: &str = "Chromium Keys";
const KWALLET_ENTRY: &str = "Chromium Safe Storage";

fn denied_or_failed(error: &SsError) -> KeySourceError {
    match error {
        // The user dismissed the unlock prompt, or the item stayed locked.
        SsError::Prompt | SsError::Locked => KeySourceError::Denied,
        other => KeySourceError::Failed(format!("Secret Service: {other}")),
    }
}

/// The session bus socket is absent or nobody listens on it: there is no service to ask. This is
/// `zbus::Error::Connection` with `NotFound` or `ConnectionRefused`, the error CI observed for
/// `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent` ("Failed to connect to address ..."). A
/// malformed address (`Error::Address`), a failed authentication or a protocol error is not "no
/// service": a bus may exist, so those stay failures.
fn no_bus(error: &zbus::Error) -> bool {
    use std::io::ErrorKind::{ConnectionRefused, NotFound};
    matches!(error, zbus::Error::Connection(io, _) if matches!(io.kind(), NotFound | ConnectionRefused))
}

/// A Secret Service connection. `Ok(None)` only when there is nothing to talk to (no session
/// bus socket, no provider on it); a failed negotiation is `Failed`, since a service exists.
fn connect<'a>() -> Result<Option<SecretService<'a>>, KeySourceError> {
    match SecretService::connect(EncryptionType::Dh) {
        Ok(service) => Ok(Some(service)),
        Err(SsError::Unavailable) => Ok(None),
        Err(SsError::Zbus(error)) if no_bus(&error) => Ok(None),
        Err(other) => Err(KeySourceError::Failed(format!(
            "Secret Service connect: {other}"
        ))),
    }
}

/// Secrets of the items matching `attributes`, unlocking locked ones. `Ok(None)` when none match.
fn read_matching(
    service: &SecretService<'_>,
    attributes: HashMap<&str, &str>,
) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
    let found = service
        .search_items(attributes)
        .map_err(|e| denied_or_failed(&e))?;
    let item: Option<&Item<'_>> = found.unlocked.first().or(found.locked.first());
    let Some(item) = item else { return Ok(None) };
    item.unlock().map_err(|e| denied_or_failed(&e))?;
    item.get_secret()
        .map(|bytes| Some(Zeroizing::new(bytes)))
        .map_err(|e| denied_or_failed(&e))
}

fn secret_service_password(app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
    let Some(service) = connect()? else {
        return Ok(None);
    };
    for schema in [CHROMIUM_SCHEMA_V2, CHROMIUM_SCHEMA_V1] {
        let attributes = HashMap::from([(SCHEMA_ATTR, schema), ("application", app_name)]);
        if let Some(found) = read_matching(&service, attributes)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn kwallet_password(app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
    let failed = |e: zbus::Error| KeySourceError::Failed(format!("KWallet: {e}"));
    let connection = match Connection::session() {
        Ok(connection) => connection,
        // No session bus to ask: there is no KWallet either.
        Err(error) if no_bus(&error) => return Ok(None),
        Err(other) => return Err(failed(other)),
    };
    let bus = DBusProxy::new(&connection).map_err(failed)?;
    for (name, path) in [
        ("org.kde.kwalletd6", "/modules/kwalletd6"),
        ("org.kde.kwalletd5", "/modules/kwalletd5"),
    ] {
        // Never start the daemon: a name nobody owns is not asked, since a bus call to an
        // activatable name would launch it.
        let owned = bus
            .name_has_owner(
                name.try_into()
                    .map_err(|e: zbus::names::Error| failed(e.into()))?,
            )
            .map_err(|e| failed(e.into()))?;
        if !owned {
            continue;
        }
        let proxy = Proxy::new(&connection, name, path, "org.kde.KWallet").map_err(failed)?;
        let enabled: bool = proxy.call("isEnabled", &()).map_err(failed)?;
        if !enabled {
            continue;
        }
        let wallet: String = proxy.call("networkWallet", &()).map_err(failed)?;
        // `open` of a wallet that does not exist offers to create it; only open a listed one.
        let wallets: Vec<String> = proxy.call("wallets", &()).map_err(failed)?;
        if !wallets.contains(&wallet) {
            continue;
        }
        let handle: i32 = proxy
            .call("open", &(wallet.as_str(), 0_i64, app_name))
            .map_err(failed)?;
        if handle < 0 {
            return Err(KeySourceError::Denied);
        }
        let result = (|| -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
            let present: bool = proxy
                .call(
                    "hasEntry",
                    &(handle, KWALLET_FOLDER, KWALLET_ENTRY, app_name),
                )
                .map_err(failed)?;
            if !present {
                return Ok(None);
            }
            let password: String = proxy
                .call(
                    "readPassword",
                    &(handle, KWALLET_FOLDER, KWALLET_ENTRY, app_name),
                )
                .map_err(failed)?;
            Ok(Some(Zeroizing::new(password.into_bytes())))
        })();
        // `close` without force only drops this client's hold on the wallet.
        let _: Result<i32, _> = proxy.call("close", &(handle, false, app_name));
        return result;
    }
    Ok(None)
}

/// Secret Service first; KWallet when no Secret Service holds the item.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeySource;

impl ChromiumKeySource for OsKeySource {
    fn password(&self, app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        if let Some(found) = secret_service_password(app_name)? {
            return Ok(Some(found));
        }
        kwallet_password(app_name)
    }

    fn windows_key(
        &self,
        _profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        Ok(None)
    }
}

/// keytar's libsecret items: schema `org.freedesktop.Secret.Generic`, string attributes
/// `service` and `account`. Many apps share that schema, so only items whose `service` is one
/// the Electron app wrote are listed, locked ones are unlocked to read their attributes, and a secret is read only on `read`.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeytar;

impl KeytarSource for OsKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        let Some(service) = connect()? else {
            return Ok(Vec::new());
        };
        let fail = |e: SsError| denied_or_failed(&e);
        let found = service
            .search_items(HashMap::from([(SCHEMA_ATTR, GENERIC_SCHEMA)]))
            .map_err(fail)?;
        let mut items = Vec::new();
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            // A cold gnome-keyring hides `service` and `account` of locked items (only hashed
            // attributes remain), so a locked item lists as nothing. Unlock first (one prompt
            // for the collection); a declined prompt is `Denied`, never an empty listing.
            item.unlock().map_err(fail)?;
            let attributes = item.get_attributes().map_err(fail)?;
            if let (Some(svc), Some(account)) =
                (attributes.get("service"), attributes.get("account"))
                && is_keytar_service(svc)
            {
                items.push((svc.clone(), account.clone()));
            }
        }
        Ok(items)
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        let Some(connection) = connect()? else {
            return Ok(None);
        };
        let attributes = HashMap::from([
            (SCHEMA_ATTR, GENERIC_SCHEMA),
            ("service", service),
            ("account", account),
        ]);
        Ok(read_matching(&connection, attributes)?
            .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
            .map(Zeroizing::new))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(kind: std::io::ErrorKind, address: &str) -> zbus::Error {
        zbus::Error::Connection(
            std::sync::Arc::new(std::io::Error::from(kind)),
            address.parse().unwrap(),
        )
    }

    #[test]
    fn only_an_unreachable_bus_socket_is_no_service() {
        use std::io::ErrorKind::{ConnectionRefused, NotFound, PermissionDenied};
        assert!(no_bus(&refused(NotFound, "unix:path=/nonexistent")));
        assert!(no_bus(&refused(
            ConnectionRefused,
            "unix:path=/run/user/1/bus"
        )));
        assert!(!no_bus(&refused(
            PermissionDenied,
            "unix:path=/run/user/1/bus"
        )));
        assert!(!no_bus(&zbus::Error::Address("malformed".into())));
    }
}
