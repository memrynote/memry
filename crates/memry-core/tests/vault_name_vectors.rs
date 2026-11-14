//! The `vault-name` conformance class, chapter 04 §4.15 and §4.16.
//!
//! The committed JSON comes out of Electron's `vault-name-crypto.ts` under a
//! fixed nonce, so a seal must reproduce Electron's bytes (the unit test in
//! `src/crypto/vault_name.rs`), and every open must agree with Electron's
//! reader: the same text, or a refusal where Electron answers `null`. Desktop
//! and Tauri devices share one account registry, so a drift here is a vault
//! list of unreadable names on the other app.

#[allow(unused_imports)]
use crate::support;

use memry_core::crypto::vault_name::{VaultText, open};
use serde_json::Value as Json;
use support::{hex_field, str_field, vector_file};

fn kind(case: &Json) -> VaultText {
    match str_field(case, "kind") {
        "name" => VaultText::Name,
        "icon" => VaultText::Icon,
        other => panic!("unknown kind {other}"),
    }
}

fn open_case(case: &Json, key: &[u8]) -> Option<String> {
    open(
        kind(case),
        key,
        str_field(case, "vaultUuid"),
        str_field(case, "ciphertextBase64"),
        str_field(case, "nonceBase64"),
    )
}

/// Every Electron-sealed name and icon opens to what Electron reads back.
#[test]
fn vault_name_electron_seals_open_to_what_electron_reads() {
    let file = vector_file("vault-name");
    let key = hex_field(&file, "keyHex");
    let seals = file["seals"].as_array().expect("seals");
    assert_eq!(seals.len(), 9);
    for case in seals {
        let name = str_field(case, "name");
        assert_eq!(
            open_case(case, &key).as_deref(),
            Some(str_field(case, "opened")),
            "{name}"
        );
    }
}

/// Tampered, misbound and wrong-key envelopes are refused where Electron
/// refuses them, and read the same where Electron reads them.
#[test]
fn vault_name_opens_agree_with_electron() {
    let file = vector_file("vault-name");
    let opens = file["opens"].as_array().expect("opens");
    assert_eq!(opens.len(), 11);
    for case in opens {
        let name = str_field(case, "name");
        let opened = open_case(case, &hex_field(case, "keyHex"));
        assert_eq!(opened.as_deref(), case["plaintext"].as_str(), "{name}");
        if let Some(text) = &opened {
            let input = str_field(case, "ciphertextBase64").len();
            assert!(text.len() <= input, "{name}: output bounded by the input");
        }
    }
}
