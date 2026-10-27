//! The vault Electron's keytar wrote, against the live OS keychain (`--features live-os-secrets`).
//!
//! `keyring_live.rs` round-trips through `KeyringStore` itself, so a wrong item name would pass
//! there. These tests write and read with the OS's own tools, the way keytar does
//! (`keytar_win.cc:120-136`, `keytar_posix.cc:14-17`, the macOS keychain's service and account):
//!
//! 1. an item written like keytar is read by `KeyringStore`;
//! 2. an item `KeyringStore` wrote is read by the OS, at the names the Electron app reads.
//!
//! macOS items are made with `security add-generic-password -A` (no trusted-app prompt on a CI
//! runner) and are read through the Security framework. Run these only on CI or a throw-away VM:
//! the macOS rows touch the login keychain.
#![cfg(feature = "live-os-secrets")]

use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::e2e::E2eGate;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::seams::secure_store::{KeyringStore, SERVICE};

/// What keytar stored for the master key: the base64 text of 32 bytes.
const KEY: [u8; 32] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 30, 31,
];
const KEY_TEXT: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

/// The macOS rows write to the login keychain: they run on CI (`CI` is set) and nowhere else, so
/// a developer's `cargo test --features live-os-secrets` never touches their own keychain.
fn skip_on_a_developer_mac() -> bool {
    cfg!(target_os = "macos") && std::env::var_os("CI").is_none()
}

fn unique() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("e2e-live-keytar-{}-{nanos}", std::process::id())
}

fn store(suffix: &str) -> KeyringStore {
    KeyringStore::new(
        Some(suffix.to_owned()),
        E2eGate::from_env(&LaunchEnv::default()),
        std::path::Path::new("."),
    )
}

/// The account keytar used for the master key of this device suffix.
fn account(suffix: &str) -> String {
    format!("master-key-{suffix}")
}

/// Removes the item natively when a test ends, pass or fail.
struct Remove(String);

impl Drop for Remove {
    fn drop(&mut self) {
        native::remove(&self.0);
    }
}

#[test]
fn an_item_written_like_keytar_is_read_by_the_store() {
    if skip_on_a_developer_mac() {
        return;
    }
    let suffix = unique();
    let _remove = Remove(account(&suffix));
    native::write_like_keytar(&account(&suffix), KEY_TEXT);
    assert_eq!(
        store(&suffix).get(SecureStoreKey::MasterKey).unwrap(),
        Some(KEY.to_vec())
    );
}

#[test]
fn an_item_the_store_wrote_is_read_natively_at_the_names_keytar_reads() {
    if skip_on_a_developer_mac() {
        return;
    }
    let suffix = unique();
    let _remove = Remove(account(&suffix));
    store(&suffix)
        .set(SecureStoreKey::MasterKey, KEY.to_vec())
        .unwrap();
    assert_eq!(native::read(&account(&suffix)).as_deref(), Some(KEY_TEXT));
}

#[cfg(target_os = "macos")]
mod native {
    use std::process::Command;

    use super::SERVICE;

    pub fn write_like_keytar(account: &str, text: &str) {
        let status = Command::new("security")
            .args([
                "add-generic-password",
                "-A",
                "-s",
                SERVICE,
                "-a",
                account,
                "-w",
                text,
            ])
            .status()
            .unwrap();
        assert!(status.success(), "security add-generic-password");
    }

    pub fn read(account: &str) -> Option<String> {
        security_framework::passwords::get_generic_password(SERVICE, account)
            .ok()
            .map(|bytes| String::from_utf8(bytes).unwrap())
    }

    pub fn remove(account: &str) {
        let _ = Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account])
            .output();
    }
}

#[cfg(windows)]
mod native {
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
        CredWriteW,
    };
    use windows::core::{HSTRING, PWSTR};

    use super::SERVICE;

    fn target(account: &str) -> HSTRING {
        HSTRING::from(format!("{SERVICE}/{account}"))
    }

    /// `SetPassword` of `keytar_win.cc`: target `service/account`, user name the account, the
    /// UTF-8 bytes as the blob, enterprise persistence.
    pub fn write_like_keytar(account: &str, text: &str) {
        let target = target(account);
        let user = HSTRING::from(account);
        let blob = text.as_bytes();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_ptr().cast_mut()),
            UserName: PWSTR(user.as_ptr().cast_mut()),
            CredentialBlobSize: u32::try_from(blob.len()).unwrap(),
            CredentialBlob: blob.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_ENTERPRISE,
            ..Default::default()
        };
        // SAFETY: `cred` points at `target`, `user` and `blob`, all alive for the call.
        unsafe { CredWriteW(&cred, 0).unwrap() };
    }

    /// The blob as text, and a check that the credential has the user name and persistence
    /// keytar gave it.
    pub fn read(account: &str) -> Option<String> {
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: CredReadW fills `credential` on success; it is read and released with CredFree.
        unsafe {
            CredReadW(&target(account), CRED_TYPE_GENERIC, None, &mut credential).ok()?;
            let cred = &*credential;
            let text = String::from_utf8(
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                    .to_vec(),
            )
            .unwrap();
            assert_eq!(cred.UserName.to_string().unwrap(), account, "UserName");
            assert_eq!(cred.Persist, CRED_PERSIST_ENTERPRISE, "Persist");
            CredFree(credential.cast());
            Some(text)
        }
    }

    pub fn remove(account: &str) {
        // SAFETY: deleting the credential a test created.
        let _ = unsafe { CredDeleteW(&target(account), CRED_TYPE_GENERIC, None) };
    }
}

/// libsecret's tools, with keytar's attributes (`keytar_posix.cc`): `service` and `account`.
/// The store searches `service` and `username` (the zbus store's attributes), and falls back to
/// keytar's when it finds nothing.
#[cfg(target_os = "linux")]
mod native {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::SERVICE;

    pub fn write_like_keytar(account: &str, text: &str) {
        let mut child = Command::new("secret-tool")
            .args([
                "store",
                "--label",
                "keytar",
                "xdg:schema",
                "org.freedesktop.Secret.Generic",
                "service",
                SERVICE,
                "account",
                account,
            ])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success(), "secret-tool store");
    }

    pub fn read(account: &str) -> Option<String> {
        let output = Command::new("secret-tool")
            .args(["lookup", "service", SERVICE, "username", account])
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).unwrap())
    }

    pub fn remove(account: &str) {
        for attribute in ["account", "username"] {
            let _ = Command::new("secret-tool")
                .args(["clear", "service", SERVICE, attribute, account])
                .output();
        }
    }
}

/// A keyring that holds a keytar item but is locked in this session hides the item from every
/// search. The store must say `Locked`, never "no key" (`MEMRY_LIVE_LOCKED_KEYRING=1` with
/// `MEMRY_LIVE_LOCKED_SUFFIX`: CI writes a keytar item, then restarts gnome-keyring without a
/// password and with no prompter to unlock it).
#[cfg(target_os = "linux")]
#[test]
fn a_locked_keyring_is_locked_never_absent() {
    use memry_core::api::errors::SecureStoreError;

    if std::env::var("MEMRY_LIVE_LOCKED_KEYRING").is_ok_and(|v| v == "1") {
        let suffix = std::env::var("MEMRY_LIVE_LOCKED_SUFFIX").unwrap();
        // An account nothing stored: the locked keyring hides nothing here, but it could hide
        // anything, so the check alone must not answer "absent" (a search finds no item, no
        // prompt is raised).
        let checked = memry_desktop::seams::secure_store::linux_absent_check(
            SERVICE,
            &account("nothing-stored-here"),
        );
        assert!(
            matches!(checked, Err(keyring_core::Error::NoStorageAccess(_))),
            "{checked:?}"
        );
        // The item that is there: the unlock prompt has no answer in this session, so the call
        // ends at the store's deadline as `Locked`.
        assert_eq!(
            store(&suffix).get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
    }
}

/// With nothing stored the check says "absent" (`Ok(None)`), and with a keytar item it says what
/// keytar stored.
#[cfg(target_os = "linux")]
#[test]
fn the_linux_absent_check_finds_keytar_items_and_nothing_else() {
    use memry_desktop::seams::secure_store::linux_absent_check;

    if std::env::var("MEMRY_LIVE_LOCKED_KEYRING").is_ok() {
        return;
    }
    let suffix = unique();
    let _remove = Remove(account(&suffix));
    assert_eq!(
        linux_absent_check(SERVICE, &account(&suffix)).unwrap(),
        None
    );
    native::write_like_keytar(&account(&suffix), KEY_TEXT);
    assert_eq!(
        linux_absent_check(SERVICE, &account(&suffix)).unwrap(),
        Some(KEY_TEXT.as_bytes().to_vec())
    );
}
