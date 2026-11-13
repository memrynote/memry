//! Core vaults declaring `Declaration::desktop()` and one relay server, for the
//! six desktop-only record types (Step 16, #3533, chapter 13 §13.1).
//!
//! The vaults are real: real SQLite, the real pull loop and the real push
//! wave. The relay is the fake: it keeps the last item pushed per id, its
//! `deletedAt` and clock included, and serves every item it holds on the next
//! pull, as one page: a live item as a ref, a deleted one in `deleted` and as a
//! `delete` item carrying its `deletedAt` and clock (§5.12). The record cipher
//! is the identity on both sides, so a payload crosses as the bytes the push
//! read from the row.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::canvas_folder;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};
use zeroize::Zeroizing;

use crate::http_fakes::{FakeTransport, response};

pub const NOW: i64 = 1_760_000_000_000;
/// `NOW` in the wire's ISO form (§13.5).
pub const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
pub const KEY: [u8; 32] = [5; 32];

/// The six types, in `DESKTOP_ONLY_RECORD_ITEM_TYPES` order.
pub const TYPES: [&str; 6] = [
    "agent_conversation",
    "agent_message",
    "canvas_folder",
    "home_page",
    "vault_lock",
    "sticky_draft",
];

/// One device: a real vault in a scratch directory.
pub struct Device {
    pub vault: Vault,
    pub id: &'static str,
    _dir: tempfile::TempDir,
}

impl Device {
    /// A vault with no at-rest key installed.
    pub fn bare(id: &'static str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix(&format!("memry-desktop-{id}-"))
            .tempdir()
            .expect("the scratch directory");
        let vault =
            Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
        Self {
            vault,
            id,
            _dir: dir,
        }
    }

    /// A vault with the at-rest key installed, as desktop runs at sync start.
    pub fn keyed(id: &'static str) -> Self {
        let device = Self::bare(id);
        device
            .vault
            .set_at_rest_key(Some(Zeroizing::new(KEY)))
            .expect("install the key");
        device
    }

    pub fn db(&self) -> Db {
        self.vault.db_handle()
    }

    /// The stored payload of `(item_type, item_id)`.
    pub fn stored(&self, item_type: &str, item_id: &str) -> String {
        let (item_type, item_id) = (item_type.to_owned(), item_id.to_owned());
        self.db()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [&item_type, &item_id],
                    |row| row.get(0),
                )
                .map_err(failed)
            })
            .expect("a stored payload")
    }

    pub fn count(&self, sql: &'static str) -> i64 {
        self.db()
            .call_blocking(move |conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
            .expect("a count")
    }
}

pub fn failed(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    ))
}

/// Opens every envelope to the payload the relay holds for its id.
struct Identity(BTreeMap<String, String>);

impl RecordCipher for Identity {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .get(&envelope.id)
            .map(|payload| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

/// One item a push sent, as the server holds it.
#[derive(Debug, Clone)]
pub struct Sent {
    pub item_type: String,
    pub item_id: String,
    pub payload: String,
    /// The tombstone instant the envelope states. The sealer sends the row's
    /// `deleted_at` whatever the operation, and a pull reads a present
    /// `deletedAt` as a delete (§5.12).
    pub deleted_at: Option<i64>,
    /// The envelope's clock: the row's clock, as the sealer sends it.
    pub clock: Option<Json>,
}

/// Records what the wave would encrypt.
#[derive(Default)]
struct Recording(Mutex<Vec<Sent>>);

impl PushSealer for Recording {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        let row = &item.row;
        self.0.lock().unwrap().push(Sent {
            item_type: row.item_type.clone(),
            item_id: row.item_id.clone(),
            payload: row.payload.clone().unwrap_or_default(),
            deleted_at: row.deleted_at,
            clock: row
                .clock
                .as_deref()
                .map(|text| serde_json::from_str(text).expect("a clock")),
        });
        Ok(json!({"id": row.item_id, "type": row.item_type}))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// The server: the last item pushed for each id.
#[derive(Default)]
pub struct Relay {
    records: Mutex<BTreeMap<String, Sent>>,
    cursor: Mutex<u64>,
}

impl Relay {
    /// Holds a live payload a peer pushed, as the server would.
    pub fn put(&self, item_type: &str, item_id: &str, payload: &str) {
        self.hold(Sent {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload: payload.to_owned(),
            deleted_at: None,
            clock: None,
        });
    }

    fn hold(&self, sent: Sent) {
        self.records
            .lock()
            .unwrap()
            .insert(sent.item_id.clone(), sent);
    }

    /// One sync pass: pull, then push, as a pass runs.
    pub async fn sync(&self, device: &Device) {
        self.pull(device).await;
        self.push(device).await;
    }

    /// Serves every held record as one page.
    pub async fn pull(&self, device: &Device) -> PullReport {
        let records = self.records.lock().unwrap().clone();
        let cursor = {
            let mut cursor = self.cursor.lock().unwrap();
            *cursor += 1;
            *cursor
        };
        let (deleted, live): (Vec<&Sent>, Vec<&Sent>) =
            records.values().partition(|sent| sent.deleted_at.is_some());
        let refs: Vec<Json> = live
            .iter()
            .map(|sent| json!({"id": sent.item_id, "type": sent.item_type}))
            .collect();
        let deleted: Vec<&str> = deleted.iter().map(|sent| sent.item_id.as_str()).collect();
        let items: Vec<Json> = records
            .values()
            .map(|sent| {
                let mut item = json!({
                    "id": sent.item_id, "type": sent.item_type,
                    "operation": if sent.deleted_at.is_some() { "delete" } else { "update" },
                    "signature": "AAAA", "signerDeviceId": "relay",
                    "blob": {"encryptedKey": "AAAA", "keyNonce": "AAAA",
                             "encryptedData": "AAAA", "dataNonce": "AAAA"},
                });
                if let Some(clock) = &sent.clock {
                    item["clock"] = clock.clone();
                }
                if let Some(deleted_at) = sent.deleted_at {
                    item["deletedAt"] = json!(deleted_at);
                }
                item
            })
            .collect();
        let transport = FakeTransport::new(vec![
            response(
                200,
                &json!({"items": refs, "deleted": deleted, "hasMore": false,
                        "nextCursor": cursor.to_string()})
                .to_string(),
            ),
            response(200, &json!({ "items": items }).to_string()),
        ]);
        let plaintexts = records
            .into_iter()
            .map(|(id, sent)| (id, sent.payload))
            .collect();
        PullLoop::new(
            http(transport),
            device.db(),
            Declaration::desktop(),
            Arc::new(Identity(plaintexts)),
        )
        .with_clock_device(device.id)
        .with_at_rest_key(device.vault.at_rest_key())
        .pull_page()
        .await
        .expect("the page")
    }

    /// Drains the device's outbox into the relay and returns what it sent.
    pub async fn push(&self, device: &Device) -> Vec<Sent> {
        let ids: Vec<String> = device
            .db()
            .call_blocking(|conn| {
                let mut statement = conn
                    .prepare("SELECT DISTINCT item_id FROM outbox")
                    .map_err(failed)?;
                statement
                    .query_map([], |row| row.get(0))
                    .and_then(Iterator::collect)
                    .map_err(failed)
            })
            .expect("the outbox");
        if ids.is_empty() {
            return Vec::new();
        }
        let accepted = json!({"accepted": ids, "rejected": [], "serverTime": 1, "maxCursor": 1});
        let recording = Arc::new(Recording::default());
        let report = PushCoordinator::new(
            http(FakeTransport::new(vec![response(
                200,
                &accepted.to_string(),
            )])),
            device.db(),
            Declaration::desktop(),
            recording.clone(),
        )
        .with_at_rest_key(device.vault.at_rest_key())
        .drain_wave()
        .await
        .expect("the wave");
        assert_eq!(report.held, 0, "nothing waits in the outbox");
        let sent = recording.0.lock().unwrap().clone();
        for item in &sent {
            self.hold(item.clone());
        }
        sent
    }
}

/// The id a peer's record of `item_type` carries here.
pub fn id_of(item_type: &str) -> String {
    match item_type {
        "agent_conversation" => "conv-1".to_owned(),
        "agent_message" => "msg-1".to_owned(),
        "canvas_folder" => canvas_folder::sync_id("Work"),
        "home_page" => "home-1".to_owned(),
        "vault_lock" => "folder:Projects".to_owned(),
        "sticky_draft" => "sticky-1".to_owned(),
        other => panic!("not a desktop-only type: {other}"),
    }
}

/// A payload of `item_type` as Electron pushes it.
pub fn wire(item_type: &str) -> Json {
    match item_type {
        "agent_conversation" => json!({
            "vaultId": "vault-1", "title": "Quarterly plan", "backend": "local",
            "backendModel": null, "trustList": [], "pinned": false,
            "clock": {"peer": 1}, "fieldClocks": {},
            "createdAt": NOW, "updatedAt": NOW, "deletedAt": null,
        }),
        "agent_message" => json!({
            "conversationId": "conv-1", "role": "user",
            "content": {"role": "user", "data": {"text": "what is due"}},
            "attachments": [], "toolCallId": null, "status": "completed",
            "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
        }),
        "canvas_folder" => json!({
            "id": id_of(item_type), "vaultId": "vault-1", "path": "Work", "icon": "star",
            "clock": {"peer": 1}, "deletedAt": null,
        }),
        "home_page" => json!({
            "id": "home-1", "name": "Home", "icon": null, "position": 0, "widgets": "[]",
            "cover": null, "clock": {"peer": 1}, "createdAt": NOW_ISO, "updatedAt": NOW_ISO,
        }),
        "vault_lock" => json!({
            "targetKind": "folder", "target": "Projects", "locked": true,
            "clock": {"peer": 1}, "createdAt": NOW_ISO, "updatedAt": NOW_ISO,
        }),
        "sticky_draft" => json!({
            "content": "call the bank", "kind": "note", "clock": {"peer": 1},
            "createdAt": NOW_ISO, "modifiedAt": NOW_ISO,
        }),
        other => panic!("not a desktop-only type: {other}"),
    }
}
