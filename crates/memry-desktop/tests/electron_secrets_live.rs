//! Tests against the live OS secret store (`--features live-os-secrets`). They create their own
//! throw-away items under test app names and remove them afterwards; they never touch an item of
//! the real Electron app. The keytar tests read the real keytar service names, so they run only
//! with `MEMRY_LIVE_KEYTAR=1` (CI sets it; a developer machine may hold real items).
#![cfg(feature = "live-os-secrets")]

use std::fs;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_desktop::electron_import::profile::{
    AppNameCandidates, HostOs, ProfileEnv, locate_profile,
};
use memry_desktop::electron_import::secrets::{
    ChromiumKeySource, Guarded, KeytarSource, OsKeySource, OsKeytar, read_all_secrets,
};
use memry_desktop::electron_import::{ElectronProfile, UnreadableReason};

const PLAIN: &str = "live-secret-value-aGVsbG8=";

fn test_name(tag: &str) -> &'static str {
    Box::leak(format!("memry-live-{tag}-{}", std::process::id()).into_boxed_str())
}

fn keytar_enabled() -> bool {
    std::env::var("MEMRY_LIVE_KEYTAR").is_ok_and(|v| v == "1")
}

/// A profile directory holding `secure-secrets.json` with one `com.memry.sync/master-key` entry.
fn profile_with(dir: &Path, ciphertext: &[u8], names: Vec<&'static str>) -> ElectronProfile {
    fs::create_dir_all(dir).unwrap();
    let store = serde_json::json!({
        "version": 1,
        "entries": {"com.memry.sync": {"master-key": STANDARD.encode(ciphertext)}}
    });
    fs::write(dir.join("secure-secrets.json"), store.to_string()).unwrap();
    let env = ProfileEnv {
        app_data: dir.to_owned(),
        override_dir: Some(dir.to_owned()),
        host: HostOs::current(),
    };
    let mut profile = locate_profile(&env).unwrap().unwrap();
    profile.app_names = AppNameCandidates(names);
    profile
}

#[cfg(unix)]
fn seal_cbc(password: &str, iterations: u32, prefix: &[u8], plain: &str) -> Vec<u8> {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    let mut key = [0_u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", iterations, &mut key);
    let body = cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[0x20_u8; 16]).into())
        .encrypt_padded_vec::<Pkcs7>(plain.as_bytes());
    [prefix, &body].concat()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;

    use super::*;

    fn exists(service: &str) -> bool {
        Command::new("security")
            .args(["find-generic-password", "-s", service])
            .output()
            .is_ok_and(|o| o.status.success())
    }

    /// A throw-away Keychain item, removed on drop. It is created by this test process through
    /// the Security framework, so this process is a trusted application of the item and the read
    /// raises no prompt (an item made by `security` would carry the `apple-tool` partition).
    struct Item(String, String);

    impl Item {
        fn create(service: &str, account: &str, password: &str) -> Self {
            security_framework::passwords::set_generic_password(
                service,
                account,
                password.as_bytes(),
            )
            .unwrap();
            Self(service.to_owned(), account.to_owned())
        }
    }

    impl Drop for Item {
        fn drop(&mut self) {
            let _ = security_framework::passwords::delete_generic_password(&self.0, &self.1);
        }
    }

    #[test]
    fn reads_the_safe_storage_item_and_decrypts_a_store() {
        let name = test_name("mac");
        let _item = Item::create(
            &format!("{name} Safe Storage"),
            &format!("{name} Key"),
            "live-password",
        );
        let password = OsKeySource.password(name).unwrap().unwrap();
        assert_eq!(&**password, b"live-password");
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(
            dir.path(),
            &seal_cbc("live-password", 1003, b"v10", PLAIN),
            vec![name],
        );
        let keys = Guarded::new(OsKeySource);
        let report = read_all_secrets(
            &profile,
            &keys,
            &memry_desktop::electron_import::secrets::NoKeytar,
        )
        .unwrap();
        assert_eq!(report.get("com.memry.sync", "master-key"), Some(PLAIN));
    }

    #[test]
    fn falls_back_to_the_legacy_account_named_after_the_app() {
        let name = test_name("mac-legacy");
        let _item = Item::create(&format!("{name} Safe Storage"), name, "legacy-password");
        assert_eq!(
            &**OsKeySource.password(name).unwrap().unwrap(),
            b"legacy-password"
        );
    }

    #[test]
    fn a_missing_item_is_none_and_no_item_is_ever_created() {
        let name = test_name("mac-absent");
        assert!(OsKeySource.password(name).unwrap().is_none());
        assert!(!exists(&format!("{name} Safe Storage")));
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(dir.path(), &seal_cbc("x", 1003, b"v10", PLAIN), vec![name]);
        let report = read_all_secrets(
            &profile,
            &OsKeySource,
            &memry_desktop::electron_import::secrets::NoKeytar,
        )
        .unwrap();
        assert_eq!(
            report.unreadable[0].reason,
            UnreadableReason::KeySourceMissing
        );
        assert!(!exists(&format!("{name} Safe Storage")));
    }

    #[test]
    fn keytar_items_are_listed_by_service_and_account() {
        if !keytar_enabled() {
            return;
        }
        let _a = Item::create("com.memry.capture", "live-acct", "keytar-value");
        let _b = Item::create("com.memry.calendar.live", "refresh-token-x", "cal-value");
        let _other = Item::create("com.example.not-ours", "acct", "ignored");
        let items = OsKeytar.items().unwrap();
        let find = |s: &str, a: &str| items.iter().find(|i| i.service == s && i.account == a);
        assert_eq!(
            find("com.memry.capture", "live-acct")
                .unwrap()
                .value
                .as_str(),
            "keytar-value"
        );
        assert_eq!(
            find("com.memry.calendar.live", "refresh-token-x")
                .unwrap()
                .value
                .as_str(),
            "cal-value"
        );
        assert!(items.iter().all(|i| i.service != "com.example.not-ours"));
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::*;

    fn secret_tool(args: &[&str], stdin: Option<&str>) -> bool {
        let mut child = Command::new("secret-tool")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("secret-tool is installed");
        if let Some(input) = stdin {
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        drop(child.stdin.take());
        child.wait().unwrap().success()
    }

    fn store(label: &str, attrs: &[&str], password: &str) {
        let mut args = vec!["store", "--label", label];
        args.extend(attrs);
        assert!(secret_tool(&args, Some(password)));
    }

    fn clear(attrs: &[&str]) {
        let mut args = vec!["clear"];
        args.extend(attrs);
        secret_tool(&args, None);
    }

    fn no_secret_service() -> bool {
        std::env::var("MEMRY_LIVE_NO_SECRET_SERVICE").is_ok_and(|v| v == "1")
    }

    #[test]
    fn reads_the_libsecret_item_and_decrypts_a_v11_store() {
        if no_secret_service() {
            return;
        }
        let name = test_name("lin");
        let attrs = [
            "xdg:schema",
            "chrome_libsecret_os_crypt_password_v2",
            "application",
            name,
        ];
        store("Chromium Safe Storage", &attrs, "live-password");
        let password = OsKeySource.password(name).unwrap().unwrap();
        assert_eq!(&**password, b"live-password");
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(
            dir.path(),
            &seal_cbc("live-password", 1, b"v11", PLAIN),
            vec![name],
        );
        let report = read_all_secrets(
            &profile,
            &Guarded::new(OsKeySource),
            &memry_desktop::electron_import::secrets::NoKeytar,
        )
        .unwrap();
        clear(&attrs);
        assert_eq!(report.get("com.memry.sync", "master-key"), Some(PLAIN));
    }

    #[test]
    fn a_missing_item_is_none_and_no_item_is_created() {
        if no_secret_service() {
            return;
        }
        let name = test_name("lin-absent");
        assert!(OsKeySource.password(name).unwrap().is_none());
        assert!(!secret_tool(
            &[
                "lookup",
                "xdg:schema",
                "chrome_libsecret_os_crypt_password_v2",
                "application",
                name
            ],
            None
        ));
    }

    /// Run with the Secret Service stopped: no service answers, the key source says "missing"
    /// and the store entry is reported unreadable, never absent.
    #[test]
    fn with_no_secret_service_the_key_is_missing_not_created() {
        if !no_secret_service() {
            return;
        }
        let name = test_name("lin-none");
        assert!(OsKeySource.password(name).unwrap().is_none());
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(dir.path(), &seal_cbc("x", 1, b"v11", PLAIN), vec![name]);
        let report = read_all_secrets(
            &profile,
            &OsKeySource,
            &memry_desktop::electron_import::secrets::NoKeytar,
        )
        .unwrap();
        assert_eq!(
            report.unreadable[0].reason,
            UnreadableReason::KeySourceMissing
        );
        assert!(OsKeytar.items().unwrap().is_empty());
    }

    #[test]
    fn keytar_items_are_listed_by_service_and_account() {
        if no_secret_service() || !keytar_enabled() {
            return;
        }
        let attrs = ["service", "com.memry.capture", "account", "live-acct"];
        store("keytar item", &attrs, "keytar-value");
        let items = OsKeytar.items().unwrap();
        clear(&attrs);
        let item = items
            .iter()
            .find(|i| i.service == "com.memry.capture" && i.account == "live-acct");
        assert_eq!(item.unwrap().value.as_str(), "keytar-value");
    }
}

#[cfg(windows)]
mod windows_live {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredWriteW,
    };
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData};
    use windows::core::{HSTRING, PWSTR};

    use super::*;

    fn dpapi_wrap(key: &[u8]) -> Vec<u8> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: key.len() as u32,
            pbData: key.as_ptr().cast_mut(),
        };
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: `input` borrows `key` for the call; `out` is a LocalAlloc buffer copied and freed here.
        unsafe {
            CryptProtectData(&input, None, None, None, None, 0, &mut out).unwrap();
            let wrapped = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
            wrapped
        }
    }

    fn seal_gcm(key: &[u8; 32], plain: &str) -> Vec<u8> {
        let nonce = [5_u8; 12];
        let sealed = Aes256Gcm::new(key.into())
            .encrypt(&Nonce::try_from(&nonce[..]).unwrap(), plain.as_bytes())
            .unwrap();
        [&b"v10"[..], &nonce, &sealed].concat()
    }

    #[test]
    fn unwraps_the_local_state_key_with_real_dpapi_and_decrypts_a_store() {
        let key = [0x42_u8; 32];
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(dir.path(), &seal_gcm(&key, PLAIN), vec!["memrynote"]);
        let wrapped = [&b"DPAPI"[..], &dpapi_wrap(&key)].concat();
        let state = serde_json::json!({"os_crypt": {"encrypted_key": STANDARD.encode(wrapped)}});
        fs::write(profile.local_state_path(), state.to_string()).unwrap();
        let unwrapped = OsKeySource.windows_key(&profile).unwrap().unwrap();
        assert_eq!(*unwrapped, key);
        let report = read_all_secrets(
            &profile,
            &Guarded::new(OsKeySource),
            &memry_desktop::electron_import::secrets::NoKeytar,
        )
        .unwrap();
        assert_eq!(report.get("com.memry.sync", "master-key"), Some(PLAIN));
    }

    #[test]
    fn a_missing_local_state_or_key_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let profile = profile_with(dir.path(), b"v10x", vec!["memrynote"]);
        assert!(OsKeySource.windows_key(&profile).unwrap().is_none());
        fs::write(profile.local_state_path(), "{}").unwrap();
        assert!(OsKeySource.windows_key(&profile).unwrap().is_none());
        fs::write(
            profile.local_state_path(),
            r#"{"os_crypt":{"encrypted_key":"AAAA"}}"#,
        )
        .unwrap();
        assert!(OsKeySource.windows_key(&profile).is_err());
    }

    #[test]
    fn keytar_credentials_are_enumerated_by_service() {
        if !keytar_enabled() {
            return;
        }
        let target = HSTRING::from("com.memry.capture/live-acct");
        let blob = b"keytar-value";
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_ptr().cast_mut()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: `cred` points at `target` and `blob`, both alive for the call.
        unsafe { CredWriteW(&cred, 0).unwrap() };
        let items = OsKeytar.items();
        // SAFETY: deleting the credential created above.
        unsafe { CredDeleteW(&target, CRED_TYPE_GENERIC, None).unwrap() };
        let items = items.unwrap();
        let item = items
            .iter()
            .find(|i| i.service == "com.memry.capture" && i.account == "live-acct");
        assert_eq!(item.unwrap().value.as_str(), "keytar-value");
    }
}
