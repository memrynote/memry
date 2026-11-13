//! The `agent-envelope` conformance class, chapter 04 §4.17.
//!
//! The committed JSON comes out of Electron's sealer
//! (`apps/desktop/src/main/agent/storage/encryption.ts`) under a fixed nonce,
//! so a seal must reproduce Electron's column byte for byte (the unit test in
//! `src/crypto/agent_envelope.rs`), and every open must agree with Electron's
//! reader: the same plaintext, or a refusal
//! where Electron throws. Step 36 copies Electron's columns unchanged, so a
//! drift here is unreadable agent history after the migration.

#[allow(unused_imports)]
use crate::support;

use memry_core::api::vault::Vault;
use memry_core::crypto::agent_envelope::{Purpose, SealError, open};
use serde_json::Value as Json;
use support::{hex_field, str_field, vector_file};
use zeroize::Zeroizing;

fn purpose(case: &Json) -> Purpose {
    match str_field(case, "purpose") {
        "agent_conversation_title" => Purpose::ConversationTitle,
        "agent_message_content" => Purpose::MessageContent,
        "agent_attachments" => Purpose::Attachments,
        other => panic!("unknown purpose {other}"),
    }
}

fn key(bytes: Vec<u8>) -> [u8; 32] {
    bytes.try_into().expect("a 32-byte key")
}

/// Every Electron column opens to what Electron reads back. The seal half,
/// byte for byte under the fixed nonce, is the unit test in
/// `src/crypto/agent_envelope.rs`: the nonce-taking seal is private.
#[test]
fn agent_envelope_electron_columns_open_to_what_electron_reads() {
    let file = vector_file("agent-envelope");
    let key = key(hex_field(&file, "keyHex"));
    let seals = file["seals"].as_array().expect("seals");
    assert_eq!(seals.len(), 9);
    for case in seals {
        let name = str_field(case, "name");
        assert_eq!(
            open(purpose(case), str_field(case, "column"), &key).expect(name),
            str_field(case, "opened"),
            "{name}"
        );
    }
}

#[test]
fn agent_envelope_opens_agree_with_electron() {
    let file = vector_file("agent-envelope");
    let opens = file["opens"].as_array().expect("opens");
    assert_eq!(opens.len(), 10);
    for case in opens {
        let name = str_field(case, "name");
        let key = key(hex_field(case, "keyHex"));
        let opened = open(purpose(case), str_field(case, "column"), &key);
        match case["plaintext"].as_str() {
            Some(expected) => assert_eq!(opened.expect(name), expected, "{name}"),
            None => assert!(opened.is_err(), "{name}: Electron refuses it"),
        }
    }
}

#[test]
fn agent_envelope_key_installed_on_the_vault_reaches_its_writers() {
    let dir = tempfile::Builder::new()
        .prefix("memry-agent-envelope-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let writer = vault.at_rest_key();
    assert!(matches!(
        writer.seal(Purpose::ConversationTitle, "plan"),
        Err(SealError::KeyUnavailable)
    ));

    let file = vector_file("agent-envelope");
    let key = key(hex_field(&file, "keyHex"));
    vault
        .set_at_rest_key(Some(Zeroizing::new(key)))
        .expect("install");
    let sealed = writer
        .seal(Purpose::ConversationTitle, "plan")
        .expect("seal");
    assert_eq!(
        open(Purpose::ConversationTitle, &sealed, &key).expect("open"),
        "plan"
    );
    let electron = &file["seals"][0];
    assert_eq!(
        writer
            .open(Purpose::ConversationTitle, str_field(electron, "column"))
            .expect("Electron's column"),
        str_field(electron, "plaintext")
    );

    vault.set_at_rest_key(None).expect("remove");
    assert!(matches!(
        writer.open(Purpose::ConversationTitle, &sealed),
        Err(SealError::KeyUnavailable)
    ));
}
