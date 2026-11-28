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
use memry_core::domain::agent_conversation::{self, NewConversation};
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::agent_queue::Queue;
use rusqlite::params;
use serde_json::{Value as Json, json};
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

/// The case of `seals` named `name`.
fn seal_case<'a>(file: &'a Json, name: &str) -> &'a Json {
    file["seals"]
        .as_array()
        .expect("seals")
        .iter()
        .find(|case| str_field(case, "name") == name)
        .expect(name)
}

/// A conversation and a message whose stored columns are Electron's read back through the record
/// reads the Tauri agent store uses (Step 28, #3545): Step 36 copies these columns unchanged.
#[test]
fn agent_envelope_electron_rows_open_through_the_record_reads() {
    let dir = tempfile::Builder::new()
        .prefix("memry-agent-envelope-rows-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let file = vector_file("agent-envelope");
    vault
        .set_at_rest_key(Some(Zeroizing::new(key(hex_field(&file, "keyHex")))))
        .expect("install");
    let title = seal_case(&file, "title, Turkish and emoji");
    let content = seal_case(&file, "message content, text parts");
    let attachments = seal_case(&file, "attachments, one file");
    let key = vault.at_rest_key();
    let (conversation, message) = vault
        .db_handle()
        .call_blocking(move |conn| {
            let new = NewConversation {
                vault_id: "vault-1",
                title: "replaced",
                backend: "claude_cli",
                backend_model: None,
            };
            let conversation =
                agent_conversation::create(conn, &key, &new, Queue::LocalOnly, "device-a", 1)
                    .expect("create");
            let placeholder = json!({"text": "replaced"});
            let new = NewMessage {
                id: Some("m1"),
                conversation_id: &conversation.id,
                role: "user",
                content: &placeholder,
                attachments: &json!([]),
                tool_call_id: None,
                status: "completed",
            };
            agent_message::append(conn, &key, &new, Queue::LocalOnly, "device-a", 1)
                .expect("append");
            for (item_type, id, field, column) in [
                (
                    "agent_conversation",
                    conversation.id.as_str(),
                    "$.title",
                    title,
                ),
                ("agent_message", "m1", "$.content", content),
                ("agent_message", "m1", "$.attachments", attachments),
            ] {
                conn.execute(
                    "UPDATE sync_items SET payload = json_set(payload, ?1, ?2)
                     WHERE item_type = ?3 AND item_id = ?4",
                    params![field, str_field(column, "column"), item_type, id],
                )
                .expect("store Electron's column");
            }
            let read = agent_conversation::get(conn, &key, &conversation.id).expect("read");
            let messages =
                agent_message::get_by_conversation(conn, &key, &conversation.id).expect("read");
            Ok((read, messages))
        })
        .expect("the database");
    let plain = |case: &Json| -> Json {
        serde_json::from_str(str_field(case, "plaintext")).expect("JSON plaintext")
    };
    assert_eq!(
        conversation.expect("live").title,
        str_field(title, "plaintext")
    );
    assert_eq!(message.len(), 1);
    assert_eq!(message[0].content, plain(content));
    assert_eq!(message[0].attachments, plain(attachments));
}
