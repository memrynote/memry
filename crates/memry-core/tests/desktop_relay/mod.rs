//! Core vaults declaring `Declaration::desktop()` and one relay server, for the
//! six desktop-only record types (Step 16, #3533, chapter 13 §13.1).
//!
//! The vaults are real: real SQLite, the real pull loop and the real push
//! wave. The relay is the fake server. A push runs the sync server's per-item
//! checks (`apps/sync-server/src/services/sync.ts`): `detectReplay` (`:230`)
//! rejects `SYNC_REPLAY_DETECTED` and `shouldRejectResurrection` (`:286`)
//! rejects `SYNC_DELETE_WINS`, both in `rejected` (`:763-775`), and a clockless
//! item of a clocked type is `VALIDATION_ERROR` (`:664`; every type but
//! `settings`). An accepted item is held as the last one for its `(type, id)`
//! (`itemIdentity`, `:583`), deleted only when its `operation` is `delete`
//! (`:865`). A pull serves
//! every held item as one page: a live item as a ref, a deleted one in
//! `deleted` and as a `delete` item carrying its `deletedAt` and clock
//! (§5.12). The record cipher is the identity on both sides, so a payload
//! crosses as the bytes the push read from the row.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::canvas_folder;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope, SyncOperation};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};
use zeroize::Zeroizing;

use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::clock::{ClockOrder, VectorClock, compare};

use crate::http_fakes::{FakeTransport, response};

pub const NOW: i64 = 1_760_000_000_000;
/// `NOW` in the wire's ISO form (§13.5).
pub const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
pub const KEY: [u8; 32] = [5; 32];
/// The server's stage-1 rejection (`sync.ts:664`).
const VALIDATION_ERROR: &str = "VALIDATION_ERROR";

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

fn http(transport: Arc<dyn Transport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    ))
}

/// A held record's identity on the server, `(type, id)` (`sync.ts:583`).
type Identity = (String, String);

/// Every record the server holds.
pub type Held = BTreeMap<Identity, Sent>;

/// Opens every envelope to the payload the relay holds for its `(type, id)`.
struct Opener(BTreeMap<Identity, String>);

impl RecordCipher for Opener {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .get(&(envelope.item_type.clone(), envelope.id.clone()))
            .map(|payload| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

/// One item a push sent, as the server holds it.
#[derive(Debug, Clone)]
pub struct Sent {
    pub item_type: String,
    pub item_id: String,
    pub operation: SyncOperation,
    pub payload: String,
    /// The tombstone instant the server stores: `deletedAt ?? now` for a
    /// `delete`, and nothing for any other operation, whatever the envelope
    /// states (`sync.ts:865`).
    pub deleted_at: Option<i64>,
    /// The envelope's clock: the row's clock, as the sealer sends it.
    pub clock: Option<VectorClock>,
    /// The server's per-item rejection, or `None` when it took the item.
    pub rejected: Option<&'static str>,
}

impl Sent {
    fn identity(&self) -> Identity {
        (self.item_type.clone(), self.item_id.clone())
    }
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
            operation: item.operation,
            rejected: None,
            payload: row.payload.clone().unwrap_or_default(),
            deleted_at: (item.operation == SyncOperation::Delete)
                .then(|| row.deleted_at.unwrap_or(NOW)),
            clock: row
                .clock
                .as_deref()
                .map(|text| serde_json::from_str(text).expect("a clock"))
                .filter(|clock: &VectorClock| !clock.is_empty()),
        });
        Ok(json!({"id": row.item_id, "type": row.item_type}))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// `POST /sync/push`: judges what the wave sealed against what the relay held
/// when the wave started.
struct PushServer {
    held: Held,
    sealed: Arc<Recording>,
}

impl PushServer {
    /// `detectReplay`, `sync.ts:230-241`.
    fn replay(incoming: Option<&VectorClock>, existing: Option<&VectorClock>) -> bool {
        match (incoming, existing) {
            (None, Some(_)) => true,
            (Some(incoming), Some(existing)) => incoming
                .iter()
                .all(|(device, tick)| *tick <= existing.get(device).copied().unwrap_or(0)),
            _ => false,
        }
    }

    /// The server's verdict on one item, `sync.ts:752-777`.
    fn verdict(&self, item: &Sent) -> Option<&'static str> {
        // Stage 1, `sync.ts:664`: `settings` is the one record type with no
        // document clock.
        if item.clock.is_none() && item.item_type != "settings" {
            return Some(VALIDATION_ERROR);
        }
        let existing = self.held.get(&item.identity())?;
        if Self::replay(item.clock.as_ref(), existing.clock.as_ref()) {
            return Some("SYNC_REPLAY_DETECTED");
        }
        // `shouldRejectResurrection`, `sync.ts:286-296`.
        let resurrects = item.operation != SyncOperation::Delete
            && existing.deleted_at.is_some()
            && matches!(
                (item.clock.as_ref(), existing.clock.as_ref()),
                (Some(incoming), Some(existing)) if compare(incoming, existing) != ClockOrder::After
            );
        resurrects.then_some("SYNC_DELETE_WINS")
    }
}

#[async_trait::async_trait]
impl Transport for PushServer {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut sealed = self.sealed.0.lock().unwrap();
        for item in sealed.iter_mut() {
            item.rejected = self.verdict(item);
        }
        let accepted: Vec<&str> = sealed
            .iter()
            .filter(|item| item.rejected.is_none())
            .map(|item| item.item_id.as_str())
            .collect();
        let rejected: Vec<Json> = sealed
            .iter()
            .filter_map(|item| Some(json!({"id": item.item_id, "reason": item.rejected?})))
            .collect();
        let body = json!({"accepted": accepted, "rejected": rejected,
                          "serverTime": 1, "maxCursor": 1});
        response(200, &body.to_string())
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        unreachable!("a push opens no socket")
    }
}

/// The server: the last item pushed for each `(type, id)`.
#[derive(Default)]
pub struct Relay {
    records: Mutex<Held>,
    cursor: Mutex<u64>,
}

impl Relay {
    /// Holds a live payload a peer pushed, as the server would: under the
    /// payload's own clock, which a peer's envelope carries.
    pub fn put(&self, item_type: &str, item_id: &str, payload: &str) {
        let clock = serde_json::from_str::<Json>(payload)
            .ok()
            .and_then(|payload| serde_json::from_value(payload["clock"].clone()).ok())
            .filter(|clock: &VectorClock| !clock.is_empty());
        self.hold(Sent {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            operation: SyncOperation::Update,
            payload: payload.to_owned(),
            deleted_at: None,
            clock,
            rejected: None,
        });
    }

    fn hold(&self, sent: Sent) {
        self.records.lock().unwrap().insert(sent.identity(), sent);
    }

    /// The payload the server holds for `(item_type, item_id)`.
    pub fn held(&self, item_type: &str, item_id: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .get(&(item_type.to_owned(), item_id.to_owned()))
            .map(|sent| sent.payload.clone())
    }

    /// One sync pass: pull, then push, as a pass runs.
    pub async fn sync(&self, device: &Device) {
        self.pull(device).await;
        self.push(device).await;
    }

    /// Serves every held record as one page.
    pub async fn pull(&self, device: &Device) -> PullReport {
        let records = self.snapshot();
        self.pull_from(device, records).await
    }

    /// What the server holds now, for a page served later.
    pub fn snapshot(&self) -> Held {
        self.records.lock().unwrap().clone()
    }

    /// Serves `records` as one page: a page read before a push that landed
    /// since, as §6.6.2's push-build / pull-apply race delivers it.
    pub async fn pull_from(&self, device: &Device, records: Held) -> PullReport {
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
                    item["clock"] = json!(clock);
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
            .map(|(identity, sent)| (identity, sent.payload))
            .collect();
        PullLoop::new(
            http(transport),
            device.db(),
            Declaration::desktop(),
            Arc::new(Opener(plaintexts)),
        )
        .with_clock_device(device.id)
        .with_at_rest_key(device.vault.at_rest_key())
        .pull_page()
        .await
        .expect("the page")
    }

    /// Drains the device's outbox into the relay and returns what it sent,
    /// each item with the server's verdict.
    pub async fn push(&self, device: &Device) -> Vec<Sent> {
        let queued: i64 = device.count("SELECT COUNT(*) FROM outbox");
        if queued == 0 {
            return Vec::new();
        }
        let sealed = Arc::new(Recording::default());
        let server = Arc::new(PushServer {
            held: self.snapshot(),
            sealed: sealed.clone(),
        });
        let report = PushCoordinator::new(
            http(server),
            device.db(),
            Declaration::desktop(),
            sealed.clone(),
        )
        .with_at_rest_key(device.vault.at_rest_key())
        .drain_wave()
        .await
        .expect("the wave");
        assert_eq!(report.held, 0, "nothing waits in the outbox");
        let sent = sealed.0.lock().unwrap().clone();
        assert!(
            sent.iter()
                .all(|item| item.rejected != Some(VALIDATION_ERROR)),
            "the sealer refuses a clockless item (`protocol/account/seal.rs:331-338`): {sent:?}"
        );
        for item in sent.iter().filter(|item| item.rejected.is_none()) {
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
