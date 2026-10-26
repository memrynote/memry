use std::collections::BTreeMap;

use super::*;
use crate::electron_import::profile::{LEGACY_APP_NAME, MEMRYNOTE_APP_NAME};
use crate::electron_import::tests::{Fixture, macos_fixture};

fn source(f: &Fixture, names: &[(&str, &str)]) -> FixedKeySource {
    let mut s = FixedKeySource::default();
    for (name, pw) in names {
        let pw = if *pw == "recorded" {
            f.expected.macos_password.clone().unwrap()
        } else {
            (*pw).to_owned()
        };
        s.passwords.insert((*name).to_owned(), pw.into_bytes());
    }
    s
}

fn expected_flat(f: &Fixture) -> BTreeMap<(String, String), String> {
    let mut out = BTreeMap::new();
    for (service, accounts) in f.expected.plaintexts.as_object().unwrap() {
        for (account, value) in accounts.as_object().unwrap() {
            out.insert(
                (service.clone(), account.clone()),
                value.as_str().unwrap().to_owned(),
            );
        }
    }
    out
}

fn assert_all_decrypted(f: &Fixture, report: &SecretsReport) {
    let expected = expected_flat(f);
    assert!(report.unreadable.is_empty(), "{:?}", report.unreadable);
    assert_eq!(report.entries.len(), expected.len());
    for ((service, account), value) in &expected {
        assert_eq!(
            report.get(service, account),
            Some(value.as_str()),
            "{service}/{account}"
        );
    }
}

#[test]
fn every_captured_entry_decrypts_to_the_recorded_plaintext() {
    for slug in ["new", "legacy"] {
        let f = macos_fixture(slug);
        let keys = source(
            &f,
            &[
                (MEMRYNOTE_APP_NAME, "recorded"),
                (LEGACY_APP_NAME, "recorded"),
            ],
        );
        let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
        assert_all_decrypted(&f, &report);
        assert!(
            report
                .entries
                .iter()
                .all(|e| e.source == SecretSource::SafeStorage)
        );
    }
}

#[test]
fn a_wrong_first_identity_falls_through_to_the_next_candidate() {
    let f = macos_fixture("new");
    let [first, second] = f.profile.app_names.0[..] else {
        panic!()
    };
    let keys = source(&f, &[(first, "wrong-password"), (second, "recorded")]);
    assert_all_decrypted(&f, &read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap());
}

#[test]
fn only_wrong_keys_are_wrong_identity_and_never_absent() {
    let f = macos_fixture("new");
    let keys = source(
        &f,
        &[(MEMRYNOTE_APP_NAME, "nope"), (LEGACY_APP_NAME, "also-nope")],
    );
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(report.entries.is_empty());
    assert_eq!(report.unreadable.len(), expected_flat(&f).len());
    assert!(
        report
            .unreadable
            .iter()
            .all(|u| u.reason == UnreadableReason::WrongIdentity)
    );
}

#[test]
fn missing_and_denied_key_sources_are_named() {
    let f = macos_fixture("new");
    let report = read_all_secrets(&f.profile, &FixedKeySource::default(), &NoKeytar).unwrap();
    assert!(
        report
            .unreadable
            .iter()
            .all(|u| u.reason == UnreadableReason::KeySourceMissing)
    );
    let denied = FixedKeySource {
        denied: true,
        ..FixedKeySource::default()
    };
    let report = read_all_secrets(&f.profile, &denied, &NoKeytar).unwrap();
    assert!(report.entries.is_empty());
    assert!(
        report
            .unreadable
            .iter()
            .all(|u| u.reason == UnreadableReason::KeySourceDenied)
    );
}

#[test]
fn corrupt_ciphertexts_are_named() {
    let f = macos_fixture("new");
    let path = f.profile.secret_store_path();
    let mut store: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    store["entries"]["com.memry.sync"]["master-key"] = "AAAA".into();
    store["entries"]["com.memry.sync"]["access-token"] = "!!not base64!!".into();
    std::fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();
    let keys = source(&f, &[(MEMRYNOTE_APP_NAME, "recorded")]);
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    let corrupt: Vec<_> = report
        .unreadable
        .iter()
        .map(|u| (u.account.as_str(), u.reason))
        .collect();
    assert_eq!(
        corrupt,
        [
            ("access-token", UnreadableReason::CorruptCiphertext),
            ("master-key", UnreadableReason::CorruptCiphertext)
        ]
    );
    assert_eq!(report.entries.len(), expected_flat(&f).len() - 2);
}

pub(super) struct FixedKeytar(pub Vec<(&'static str, &'static str, &'static str)>);

impl KeytarSource for FixedKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        Ok(self
            .0
            .iter()
            .map(|(s, a, _)| ((*s).into(), (*a).into()))
            .collect())
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        Ok(self
            .0
            .iter()
            .find(|(s, a, _)| *s == service && *a == account)
            .map(|(_, _, v)| Zeroizing::new((*v).into())))
    }
}

#[test]
fn keytar_fills_unreadable_and_missing_entries_and_never_overrides_a_decrypt() {
    let f = macos_fixture("new");
    let keytar = FixedKeytar(vec![
        ("com.memry.sync", "master-key", "from-keytar"),
        ("com.memry.sync", "extra", "only-keytar"),
    ]);
    // Decryptable: the safeStorage value wins over keytar.
    let keys = source(&f, &[(MEMRYNOTE_APP_NAME, "recorded")]);
    let report = read_all_secrets(&f.profile, &keys, &keytar).unwrap();
    assert_eq!(
        report.get("com.memry.sync", "master-key"),
        Some("fixture-master-key-aGVsbG8=")
    );
    assert_eq!(report.get("com.memry.sync", "extra"), Some("only-keytar"));
    assert!(report.unreadable.is_empty());
    // Undecryptable: the keytar copy fills the entry and it is no longer unreadable.
    let report = read_all_secrets(&f.profile, &FixedKeySource::default(), &keytar).unwrap();
    assert_eq!(
        report.get("com.memry.sync", "master-key"),
        Some("from-keytar")
    );
    assert_eq!(report.unreadable.len(), expected_flat(&f).len() - 1);
    assert!(report.unreadable.iter().all(|u| u.account != "master-key"));
}

#[test]
fn debug_never_prints_the_value() {
    let entry = SecretEntry {
        service: "svc".into(),
        account: "acct".into(),
        value: Zeroizing::new("hunter2".into()),
        source: SecretSource::Keytar,
    };
    let shown = format!("{entry:?}");
    assert!(shown.contains("svc") && shown.contains("acct") && !shown.contains("hunter2"));
}

#[test]
fn store_file_parse_is_strict_about_json_and_lenient_about_leaves() {
    assert!(SecretStoreFile::parse(b"nope").is_err());
    assert!(SecretStoreFile::parse(br#"{"version":1}"#).is_err());
    let store = SecretStoreFile::parse(br#"{"entries":{"s":{"a":"x","b":3},"t":7}}"#).unwrap();
    assert_eq!(store.entries["s"].len(), 2);
    assert_eq!(store.entries["s"]["b"], StoreLeaf::Malformed);
    assert_eq!(store.malformed_services, ["t"]);
}

#[test]
fn absent_store_is_no_secrets() {
    let f = macos_fixture("new");
    std::fs::remove_file(f.profile.secret_store_path()).unwrap();
    let report = read_all_secrets(&f.profile, &FixedKeySource::default(), &NoKeytar).unwrap();
    assert!(report.entries.is_empty() && report.unreadable.is_empty());
}

#[test]
fn unparseable_store_is_an_error_and_is_not_renamed() {
    let f = macos_fixture("new");
    let path = f.profile.secret_store_path();
    std::fs::write(&path, "garbage").unwrap();
    let err = read_all_secrets(&f.profile, &FixedKeySource::default(), &NoKeytar).unwrap_err();
    assert!(matches!(err, ImportError::Parse { .. }));
    assert!(path.exists());
    let leftovers = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
        .count();
    assert_eq!(leftovers, 0);
}

fn seal(password: &str, plain: &str) -> String {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    let mut key = [0_u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    let body = cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[0x20_u8; 16]).into())
        .encrypt_padded_vec::<Pkcs7>(plain.as_bytes());
    STANDARD.encode([&b"v10"[..], &body].concat())
}

fn rewrite_store(f: &Fixture, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = f.profile.secret_store_path();
    let mut store: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    edit(&mut store);
    std::fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();
}

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

#[test]
fn a_non_ascii_plaintext_survives_under_a_key_the_other_entries_validated() {
    let f = macos_fixture("new");
    let password = f.expected.macos_password.clone().unwrap();
    rewrite_store(&f, |s| {
        s["entries"]["com.memry.readwise"]["accented"] = seal(&password, "şifre-ğüş").into();
    });
    let keys = source(
        &f,
        &[
            (MEMRYNOTE_APP_NAME, "recorded"),
            (LEGACY_APP_NAME, "recorded"),
        ],
    );
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(report.unreadable.is_empty(), "{:?}", report.unreadable);
    assert_eq!(
        report.get("com.memry.readwise", "accented"),
        Some("şifre-ğüş")
    );
}

#[test]
fn a_non_ascii_plaintext_alone_validates_nothing_and_is_unreadable() {
    let f = macos_fixture("new");
    let password = f.expected.macos_password.clone().unwrap();
    rewrite_store(&f, |s| {
        s["entries"] = serde_json::json!({"svc": {"acct": seal(&password, "şifre")}});
    });
    let keys = source(
        &f,
        &[
            (MEMRYNOTE_APP_NAME, "recorded"),
            (LEGACY_APP_NAME, "recorded"),
        ],
    );
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    assert!(report.entries.is_empty());
    assert_eq!(report.unreadable.len(), 1);
    assert_eq!(report.unreadable[0].reason, UnreadableReason::WrongIdentity);
}

#[test]
fn malformed_entries_are_corrupt_never_absent() {
    let f = macos_fixture("new");
    rewrite_store(&f, |s| {
        s["entries"]["com.memry.readwise"]["number"] = 5.into();
        s["entries"]["com.memry.calendar.google"] = "not an object".into();
    });
    let keys = source(&f, &[(MEMRYNOTE_APP_NAME, "recorded")]);
    let report = read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
    let mut corrupt: Vec<_> = report
        .unreadable
        .iter()
        .map(|u| (u.service.as_str(), u.account.as_str(), u.reason))
        .collect();
    corrupt.sort();
    assert_eq!(
        corrupt,
        [
            (
                "com.memry.calendar.google",
                "",
                UnreadableReason::CorruptCiphertext
            ),
            (
                "com.memry.readwise",
                "number",
                UnreadableReason::CorruptCiphertext
            ),
        ]
    );
    assert_eq!(
        report.get("com.memry.sync", "master-key"),
        Some("fixture-master-key-aGVsbG8=")
    );
}

#[test]
fn an_unknown_store_version_or_layout_is_an_error() {
    assert!(matches!(
        SecretStoreFile::parse(br#"{"version":2,"entries":{}}"#),
        Err(ImportError::UnsupportedVersion { .. })
    ));
    assert!(matches!(
        SecretStoreFile::parse(br#"{"version":"1","entries":{}}"#),
        Err(ImportError::UnsupportedVersion { .. })
    ));
    assert!(matches!(
        SecretStoreFile::parse(br#"{"version":1,"entries":[]}"#),
        Err(ImportError::UnsupportedLayout(_))
    ));
    assert!(SecretStoreFile::parse(br#"{"entries":{}}"#).is_ok());
}
