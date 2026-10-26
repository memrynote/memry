//! Every reader against the profile Electron 43.1.1 wrote on each OS (macOS, the Windows 11 VM
//! and the Ubuntu VM). The decrypt tests use the key material `capture.mjs` recorded: the macOS
//! mock-keychain password, the Linux libsecret password and the Windows unwrapped 32-byte key,
//! so the result does not depend on the machine running the test.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::*;
use crate::electron_import::secrets::{FixedKeySource, NoKeytar, read_all_secrets};
use crate::electron_import::{
    CustomDictionary, ElectronConfig, LocalStorageSnapshot, UnreadableReason, YStoreReader,
};

const OSES: [(&str, HostOs); 3] = [
    ("macos", HostOs::MacOs),
    ("linux", HostOs::Linux),
    ("windows", HostOs::Windows),
];

fn keys(f: &Fixture) -> FixedKeySource {
    let mut keys = FixedKeySource::default();
    for password in [&f.expected.macos_password, &f.expected.linux_password]
        .into_iter()
        .flatten()
    {
        for name in ["memrynote", "@memry/desktop"] {
            keys.passwords
                .insert(name.to_owned(), password.clone().into_bytes());
        }
    }
    if let Some(key) = &f.expected.windows_key_base64 {
        keys.windows_key = Some(STANDARD.decode(key).unwrap().try_into().unwrap());
    }
    keys
}

#[test]
fn every_os_fixture_decrypts_to_the_recorded_plaintexts() {
    for (os, host) in OSES {
        for slug in ["new", "legacy"] {
            let f = fixture(os, slug, host);
            let report = read_all_secrets(&f.profile, &keys(&f), &NoKeytar).unwrap();
            assert!(
                report.unreadable.is_empty(),
                "{os}/{slug}: {:?}",
                report.unreadable
            );
            let mut seen = 0;
            for (service, accounts) in f.expected.plaintexts.as_object().unwrap() {
                for (account, value) in accounts.as_object().unwrap() {
                    assert_eq!(
                        report.get(service, account),
                        Some(value.as_str().unwrap()),
                        "{os}/{slug} {service}/{account}"
                    );
                    seen += 1;
                }
            }
            assert_eq!(report.entries.len(), seen, "{os}/{slug}");
        }
    }
}

#[test]
fn the_wrong_key_material_is_unreadable_on_every_os() {
    for (os, host) in OSES {
        let f = fixture(os, "new", host);
        let mut wrong = FixedKeySource::default();
        for name in ["memrynote", "@memry/desktop"] {
            wrong
                .passwords
                .insert(name.to_owned(), b"not-the-password".to_vec());
        }
        wrong.windows_key = Some([9; 32]);
        let report = read_all_secrets(&f.profile, &wrong, &NoKeytar).unwrap();
        assert!(report.entries.is_empty(), "{os}");
        assert!(!report.unreadable.is_empty(), "{os}");
        assert!(
            report
                .unreadable
                .iter()
                .all(|u| u.reason == UnreadableReason::WrongIdentity),
            "{os}: {:?}",
            report.unreadable
        );
    }
}

#[test]
fn the_ciphertext_prefix_matches_the_os_layout() {
    for (os, host, prefix) in [
        ("macos", HostOs::MacOs, b"v10"),
        ("linux", HostOs::Linux, b"v11"),
        ("windows", HostOs::Windows, b"v10"),
    ] {
        let f = fixture(os, "new", host);
        let store = crate::electron_import::secrets::SecretStoreFile::read(&f.profile)
            .unwrap()
            .unwrap();
        for accounts in store.entries.values() {
            for leaf in accounts.values() {
                let crate::electron_import::secrets::StoreLeaf::Ciphertext(b64) = leaf else {
                    panic!("{os}: malformed leaf in a real Electron store");
                };
                assert_eq!(&STANDARD.decode(b64).unwrap()[..3], prefix, "{os}");
            }
        }
    }
}

#[test]
fn every_other_reader_agrees_on_every_os() {
    for (os, host) in OSES {
        let f = fixture(os, "new", host);
        let config = ElectronConfig::read(&f.profile).unwrap().unwrap();
        assert_eq!(config.vaults().0.len(), 1, "{os}");
        let snapshot = LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.entries.len(), 4, "{os}");
        assert_eq!(snapshot.entries["anahtar-ğ"], "değer", "{os}");
        let dictionary = CustomDictionary::read(&f.profile).unwrap().unwrap();
        assert!(dictionary.checksum_ok, "{os}");
        assert_eq!(dictionary.words.len(), 3, "{os}");
        let store = YStoreReader::open(
            &f.profile,
            &f.expected.vault_uuid,
            Some(&config),
            &f.scratch,
        )
        .unwrap()
        .unwrap();
        assert_eq!(store.updates(&f.expected.note_id).len(), 300, "{os}");
        assert_eq!(store.ignored_keys(), 0, "{os}");
        assert_eq!(store.store_epoch(), Some("epoch-fixture-1"), "{os}");
        let mark = store.watermark(&f.expected.note_id).unwrap();
        assert_eq!(mark.applied_sequence, 42, "{os}");
        assert!(store.watermark(&f.expected.journal_id).is_none(), "{os}");
    }
}
