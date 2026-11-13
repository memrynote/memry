//! Agent records sealed at rest, end to end (Step 16, #3533; chapter 04
//! §4.17, chapter 13 §13.7.26-27).
//!
//! A real vault, the real pull loop and the real push wave; the fakes are the
//! transport and the record cipher, as in `unknown_fields.rs`. Three
//! obligations:
//!
//! - a message pulled before the vault key is installed is stored pending and
//!   sealed by `Vault::set_at_rest_key` (`agent_sealed_pending`);
//! - no title or message text reaches the database file;
//! - the push opens the sealed keys, so the wire payload is the plain schema
//!   payload, and without a key a sealed row waits in the outbox;
//! - a row sealed under another key is never read as plain or sealed again,
//!   and a key that fails the vault's verifier is not installed.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::Path;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::crypto::agent_envelope::{Purpose, SealError, open};
use memry_core::crypto::keys::local_vault_key_verifier;
use memry_core::domain::agent_conversation::{self, NewConversation};
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::agent_records::AgentError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};
use zeroize::Zeroizing;

const NOW: i64 = 1_760_000_000_000;
const KEY: [u8; 32] = [5; 32];
const OTHER_KEY: [u8; 32] = [6; 32];
const TITLE: &str = "PLAINTEXT-TITLE quarterly plan";
const FIRST: &str = "PLAINTEXT-MESSAGE-ONE what is due";
const SECOND: &str = "PLAINTEXT-MESSAGE-TWO three tasks";

struct Fixture {
    vault: Vault,
    dir: tempfile::TempDir,
}

fn vault(label: &str) -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-agent-{label}-"))
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    Fixture { vault, dir }
}

fn declaration() -> Declaration {
    Declaration::declare(&["agent_conversation", "agent_message"]).expect("a declaration")
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    ))
}

/// Opens every envelope to the one scripted plaintext.
struct Plain(String);

impl RecordCipher for Plain {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0.as_bytes().to_vec())
    }
}

/// Records the payload text the wave would encrypt for the wire.
#[derive(Default)]
struct Recording(Mutex<Vec<Json>>);

impl PushSealer for Recording {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        let payload = item.row.payload.clone().unwrap_or_default();
        self.0
            .lock()
            .unwrap()
            .push(serde_json::from_str(&payload).expect("json"));
        Ok(json!({"id": item.row.item_id, "type": item.row.item_type}))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

fn message_content(text: &str) -> Json {
    json!({"role": "user", "data": {"text": text}})
}

fn scalar<T: rusqlite::types::FromSql + Send + 'static>(db: &Db, sql: &'static str) -> T {
    db.call_blocking(move |conn| {
        conn.query_row(sql, [], |row| row.get(0)).map_err(|error| {
            memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .expect("query")
}

/// Every byte SQLite holds for this vault: the database and its WAL.
fn file_bytes(dir: &Path) -> Vec<u8> {
    ["data.db", "data.db-wal"]
        .iter()
        .filter_map(|name| std::fs::read(dir.join(name)).ok())
        .flatten()
        .collect()
}

fn occurrences(haystack: &[u8], needle: &str) -> usize {
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle.as_bytes())
        .count()
}

/// Pulls message `m1` with `FIRST` as its text into `fixture` through the
/// real pull loop, with whatever key the vault holds.
async fn pull_message(fixture: &Fixture, content: &Json) {
    let wire = json!({
        "conversationId": "conv-1", "role": "user", "content": content,
        "attachments": [], "toolCallId": null, "status": "completed",
        "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
    });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": "m1", "type": "agent_message"}], "deleted": [],
                    "hasMore": false, "nextCursor": "7"})
            .to_string(),
        ),
        response(
            200,
            &json!({"items": [{
                "id": "m1", "type": "agent_message", "operation": "update",
                "signature": "AAAA", "signerDeviceId": "peer",
                "blob": {"encryptedKey": "AAAA", "keyNonce": "AAAA",
                         "encryptedData": "AAAA", "dataNonce": "AAAA"},
            }]})
            .to_string(),
        ),
    ]);
    let report = PullLoop::new(
        http(transport),
        fixture.vault.db_handle(),
        declaration(),
        Arc::new(Plain(wire.to_string())),
    )
    .with_at_rest_key(fixture.vault.at_rest_key())
    .pull_page()
    .await
    .expect("the page");
    assert_eq!((report.applied, report.corrupt), (1, 0));
}

#[tokio::test]
async fn agent_sealed_pending_message_is_sealed_when_the_key_arrives() {
    let fixture = vault("pending");
    let db = fixture.vault.db_handle();
    // Longer than a page, so the plain text also sits in overflow pages.
    let content = message_content(&FIRST.repeat(200));
    pull_message(&fixture, &content).await;
    let (pending, column): (i64, String) = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_sealed_pending WHERE item_id = 'm1'), content
                 FROM agent_messages WHERE id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the row");
    assert_eq!(
        (pending, column.as_str()),
        (1, ""),
        "no key: stored pending, column empty"
    );
    // The plain row reaches the main file, as an automatic checkpoint would
    // move it there before the key arrives.
    db.call_blocking(|conn| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("checkpoint");
    assert!(occurrences(&file_bytes(fixture.dir.path()), FIRST) > 0);

    let sealed = fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("seal pending");
    assert_eq!((sealed.records, sealed.wal_kept), (1, false));
    assert_eq!(
        scalar::<i64>(&db, "SELECT COUNT(*) FROM agent_sealed_pending"),
        0
    );
    let column: String = scalar(&db, "SELECT content FROM agent_messages WHERE id = 'm1'");
    let opened: Json =
        serde_json::from_str(&open(Purpose::MessageContent, &column, &KEY).expect("opens"))
            .expect("json");
    assert_eq!(opened, content, "the column opens to the pushed text");
    let stored: String = scalar(
        &db,
        "SELECT payload FROM sync_items WHERE item_type = 'agent_message' AND item_id = 'm1'",
    );
    assert!(!stored.contains(FIRST), "the stored payload is sealed too");
    assert_eq!(
        occurrences(&file_bytes(fixture.dir.path()), FIRST),
        0,
        "the plain text the seal replaced is gone from the database file and its WAL"
    );
}

#[tokio::test]
async fn agent_pending_record_pushes_plain_with_no_key() {
    let fixture = vault("pending-push");
    let db = fixture.vault.db_handle();
    let content = message_content(FIRST);
    pull_message(&fixture, &content).await;
    db.call_blocking(|conn| agent_message::delete(conn, "m1", "device-a", NOW + 1))
        .map(|deleted| assert!(deleted))
        .expect("delete");

    let recording = Arc::new(Recording::default());
    let accepted = json!({"accepted": ["m1"], "rejected": [], "serverTime": 1, "maxCursor": 1});
    let report = PushCoordinator::new(
        http(FakeTransport::new(vec![response(
            200,
            &accepted.to_string(),
        )])),
        db.clone(),
        declaration(),
        recording.clone(),
    )
    .with_at_rest_key(fixture.vault.at_rest_key())
    .drain_wave()
    .await
    .expect("the wave");
    assert_eq!((report.accepted, report.held, report.retired), (1, 0, 0));
    let sent = recording.0.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0]["content"], content,
        "the plain pending text goes as is"
    );
}

#[tokio::test]
async fn agent_text_never_reaches_the_database_file_and_pushes_plain() {
    let fixture = vault("at-rest");
    let db = fixture.vault.db_handle();
    let key = fixture.vault.at_rest_key();
    fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("install");
    let (first, second) = (message_content(FIRST), message_content(SECOND));
    let conversation = db
        .call_blocking(|conn| {
            let new = NewConversation {
                vault_id: "vault-1",
                title: TITLE,
                backend: "local",
                backend_model: None,
            };
            let conversation =
                agent_conversation::create(conn, &key, &new, "device-a", NOW).map_err(failed)?;
            for (id, content) in [("m1", &first), ("m2", &second)] {
                let new = NewMessage {
                    id: Some(id),
                    conversation_id: &conversation.id,
                    role: "user",
                    content,
                    attachments: &json!([]),
                    tool_call_id: None,
                    status: "completed",
                };
                agent_message::append(conn, &key, &new, "device-a", NOW).map_err(failed)?;
            }
            Ok(conversation)
        })
        .expect("writes");
    db.call_blocking(|conn| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("checkpoint");
    let bytes = file_bytes(fixture.dir.path());
    for text in [TITLE, FIRST, SECOND] {
        assert_eq!(
            occurrences(&bytes, text),
            0,
            "`{text}` is in the database file"
        );
    }
    assert_eq!(scalar::<i64>(&db, "SELECT COUNT(*) FROM outbox"), 3);

    // No key: every sealed row waits in the outbox, nothing goes out.
    fixture.vault.set_at_rest_key(None).expect("remove");
    let recording = Arc::new(Recording::default());
    let report = PushCoordinator::new(
        http(FakeTransport::new(vec![])),
        db.clone(),
        declaration(),
        recording.clone(),
    )
    .with_at_rest_key(key.clone())
    .drain_wave()
    .await
    .expect("the wave");
    assert_eq!((report.held, report.retired), (3, 0));
    assert!(recording.0.lock().unwrap().is_empty());
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT COUNT(*) FROM outbox WHERE last_error LIKE 'held until it opens%'
             AND next_attempt_at IS NOT NULL"
        ),
        3
    );

    // The key arrives: the held rows are due again and push opened.
    fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("install");
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT COUNT(*) FROM outbox WHERE next_attempt_at IS NULL"
        ),
        3
    );
    let accepted = json!({"accepted": [conversation.id, "m1", "m2"], "rejected": [],
                          "serverTime": 1, "maxCursor": 1});
    let report = PushCoordinator::new(
        http(FakeTransport::new(vec![response(
            200,
            &accepted.to_string(),
        )])),
        db.clone(),
        declaration(),
        recording.clone(),
    )
    .with_at_rest_key(key)
    .drain_wave()
    .await
    .expect("the wave");
    assert_eq!((report.accepted, report.held), (3, 0));
    let sent = recording.0.lock().unwrap().clone();
    let title = sent.iter().find_map(|payload| payload.get("title"));
    assert_eq!(title, Some(&json!(TITLE)), "the wire title is plain");
    let contents: Vec<&Json> = sent
        .iter()
        .filter_map(|payload| payload.get("content"))
        .collect();
    assert_eq!(contents, vec![&first, &second], "the wire content is plain");
    assert!(
        sent.iter()
            .all(|payload| payload.get("attachments").is_none_or(|a| a == &json!([])))
    );
}

/// A conversation and its message sealed under one key, then another key
/// installed: Electron throws on reading, merging and pushing such a row
/// (`vault-key-state.ts:35-62`), and so does this core. Neither the read nor
/// the push treats the envelope as plain text, and installing the key seals
/// nothing again (§13.2.3).
#[tokio::test]
async fn agent_record_under_another_key_errors_holds_and_is_never_sealed_again() {
    let fixture = vault("foreign-key");
    let db = fixture.vault.db_handle();
    let key = fixture.vault.at_rest_key();
    fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("install");
    let writer = key.clone();
    let conversation = db
        .call_blocking(move |conn| {
            let new = NewConversation {
                vault_id: "vault-1",
                title: TITLE,
                backend: "local",
                backend_model: None,
            };
            let id = agent_conversation::create(conn, &writer, &new, "device-a", NOW)
                .map_err(failed)?
                .id;
            let message = NewMessage {
                id: Some("m1"),
                conversation_id: &id,
                role: "user",
                content: &message_content(FIRST),
                attachments: &json!([]),
                tool_call_id: None,
                status: "completed",
            };
            agent_message::append(conn, &writer, &message, "device-a", NOW).map_err(failed)?;
            Ok(id)
        })
        .expect("writes");
    let payloads = "SELECT group_concat(payload, '|') FROM
                    (SELECT payload FROM sync_items ORDER BY item_type, item_id)";
    let before: String = scalar(&db, payloads);

    for _ in 0..2 {
        let sealed = fixture
            .vault
            .set_at_rest_key(Some(Zeroizing::new(OTHER_KEY)))
            .expect("another key, no verifier stored");
        assert_eq!(sealed.records, 0);
        assert_eq!(scalar::<String>(&db, payloads), before, "byte-identical");
    }

    let reader = key.clone();
    let id = conversation.clone();
    let (title, messages) = db
        .call_blocking(move |conn| {
            Ok((
                agent_conversation::get(conn, &reader, &id).map(drop),
                agent_message::get_by_conversation(conn, &reader, &id).map(drop),
            ))
        })
        .expect("reads");
    for read in [title, messages] {
        assert!(
            matches!(read, Err(AgentError::Envelope(SealError::Crypto(_)))),
            "{read:?}"
        );
    }

    let recording = Arc::new(Recording::default());
    let report = PushCoordinator::new(
        http(FakeTransport::new(vec![])),
        db.clone(),
        declaration(),
        recording.clone(),
    )
    .with_at_rest_key(key)
    .drain_wave()
    .await
    .expect("the wave");
    assert_eq!((report.accepted, report.held, report.retired), (0, 2, 0));
    assert!(recording.0.lock().unwrap().is_empty(), "nothing goes out");
}

#[test]
fn agent_key_that_fails_the_vault_verifier_is_not_installed() {
    let fixture = vault("verifier");
    let verifier = local_vault_key_verifier(&KEY, &fixture.vault.id()).expect("a verifier");
    fixture
        .vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('vault.crypto.verifier.v1', ?1)",
                [verifier],
            )
            .map(drop)
            .map_err(failed)
        })
        .expect("stored verifier");
    let key = fixture.vault.at_rest_key();

    let refused = fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(OTHER_KEY)));
    assert!(
        matches!(refused, Err(StorageError::Invalid { .. })),
        "{refused:?}"
    );
    assert!(matches!(
        key.seal(Purpose::ConversationTitle, "plan"),
        Err(SealError::KeyUnavailable)
    ));

    fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("the vault's own key");
    assert!(key.seal(Purpose::ConversationTitle, "plan").is_ok());
}

/// A reader holds the WAL and the writer does not wait: the seal commits and
/// says the WAL may still hold the plain pages.
#[tokio::test]
async fn agent_seal_reports_a_wal_a_reader_kept() {
    let fixture = vault("wal-kept");
    let db = fixture.vault.db_handle();
    pull_message(&fixture, &message_content(FIRST)).await;
    let reader = rusqlite::Connection::open(fixture.dir.path().join("data.db")).expect("a reader");
    reader.execute_batch("BEGIN").expect("begin");
    let rows: i64 = reader
        .query_row("SELECT COUNT(*) FROM sync_items", [], |row| row.get(0))
        .expect("a snapshot");
    assert_eq!(rows, 1);
    db.call_blocking(|conn| conn.busy_timeout(std::time::Duration::ZERO).map_err(failed))
        .expect("no wait");

    let sealed = fixture
        .vault
        .set_at_rest_key(Some(Zeroizing::new(KEY)))
        .expect("seal");
    assert_eq!((sealed.records, sealed.wal_kept), (1, true));
    reader.execute_batch("COMMIT").expect("end");
}

fn failed(error: impl std::fmt::Display) -> memry_core::api::errors::StorageError {
    memry_core::api::errors::StorageError::Failed {
        what: error.to_string(),
    }
}
