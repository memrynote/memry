//! Orphan repair (Step 17 L3b, #3534; `sync::hardening::orphans`) through the
//! real hardened pull: a child whose parent is a tombstone here is
//! tombstoned and its delete queued; a child whose parent is only absent is
//! kept, and the absent parent is fetched by id once per pull loop.
//!
//! Real `HttpClient`, SQLite, apply and domain deletes; the transport and the
//! record cipher are the only fakes. One `PullLoop` plays one driver across
//! several runs, so the per-loop memory of fetched parents is the real one.

#[allow(unused_imports)]
use crate::http_fakes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, body_json, response};
use memry_core::api::errors::StorageError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};

const DEVICE: &str = "device-a";
const NOW: i64 = 1_760_000_000_000;

/// Opens each envelope to the payload scripted for its id.
#[derive(Default)]
struct Payloads(Mutex<HashMap<String, Json>>);

impl Payloads {
    fn set(&self, id: &str, payload: Json) {
        self.0.lock().unwrap().insert(id.to_owned(), payload);
    }
}

impl RecordCipher for Payloads {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        let payload = self.0.lock().unwrap().get(&envelope.id).cloned();
        Ok(payload
            .unwrap_or_else(|| panic!("no payload scripted for {}", envelope.id))
            .to_string()
            .into_bytes())
    }
}

/// One hardened desktop pull loop over a scratch vault, scripted per run.
struct Device {
    db: Db,
    transport: Arc<FakeTransport>,
    payloads: Arc<Payloads>,
    pull: PullLoop,
}

fn device() -> Device {
    let dir = tempfile::Builder::new()
        .prefix("memry-hardening-orphans-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    let transport = FakeTransport::new(Vec::new());
    let payloads = Arc::new(Payloads::default());
    let http = HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::declare(&[
            "project",
            "task",
            "calendar_source",
            "calendar_external_event",
            "agent_conversation",
            "agent_message",
        ])
        .expect("recognised"),
        payloads.clone(),
    )
    .with_hardening()
    .with_clock_device(DEVICE);
    Device {
        db,
        transport,
        payloads,
        pull,
    }
}

fn envelope(id: &str, item_type: &str) -> Json {
    json!({
        "id": id, "type": item_type, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "peer",
    })
}

fn tombstone(id: &str, item_type: &str) -> Json {
    let mut item = envelope(id, item_type);
    item["deletedAt"] = json!(NOW + 1_000);
    item
}

fn items(envelopes: Vec<Json>) -> String {
    json!({ "items": envelopes }).to_string()
}

impl Device {
    fn script(&self, bodies: &[String]) {
        for body in bodies {
            self.transport.push(response(200, body));
        }
    }

    /// One feed page carrying `envelopes`, applied by a full run.
    async fn run_page(&self, envelopes: Vec<Json>, cursor: &str) {
        let listed: Vec<Json> = envelopes
            .iter()
            .map(|item| json!({"id": item["id"], "type": item["type"]}))
            .collect();
        self.script(&[
            json!({"items": listed, "deleted": [], "hasMore": false, "nextCursor": cursor})
                .to_string(),
            items(envelopes),
        ]);
        let report = self.pull.run(5).await.expect("the run");
        assert!(report.applied + report.deleted > 0, "the page delivered");
    }

    fn deleted_at(&self, item_type: &'static str, id: &str) -> Option<i64> {
        let id = id.to_owned();
        self.db
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [item_type, id.as_str()],
                    |row| row.get(0),
                )
                .map_err(failed)
            })
            .expect("the row")
    }

    fn queued(&self, item_type: &'static str, id: &str) -> Vec<String> {
        let id = id.to_owned();
        self.db
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare("SELECT op FROM outbox WHERE item_type = ?1 AND item_id = ?2")
                    .map_err(failed)?;
                statement
                    .query_map([item_type, id.as_str()], |row| row.get(0))
                    .map_err(failed)?
                    .collect::<Result<_, _>>()
                    .map_err(failed)
            })
            .expect("the outbox")
    }

    fn pulled_ids(&self) -> Vec<Json> {
        self.transport
            .calls_to("/sync/pull")
            .iter()
            .map(|call| body_json(call)["itemIds"].clone())
            .collect()
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn project() -> Json {
    json!({"title": "Launch", "clock": {"peer": 1}})
}

fn task(project_id: &str) -> Json {
    json!({"title": "Ship it", "projectId": project_id, "clock": {"peer": 1}})
}

fn conversation() -> Json {
    json!({
        "vaultId": "vault-1", "title": "Quarterly plan", "backend": "local",
        "backendModel": null, "trustList": [], "pinned": false,
        "clock": {"peer": 1}, "fieldClocks": {},
        "createdAt": NOW, "updatedAt": NOW, "deletedAt": null,
    })
}

fn message(conversation_id: &str) -> Json {
    json!({
        "conversationId": conversation_id, "role": "user",
        "content": {"role": "user", "data": {"text": "what is due"}},
        "attachments": [], "toolCallId": null, "status": "completed",
        "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
    })
}

fn source() -> Json {
    json!({
        "id": "src-work", "provider": "google", "kind": "calendar", "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com", "title": "Work", "isSelected": true,
        "isPrimary": false, "isMemryManaged": false, "clock": {"peer": 1},
        "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    })
}

fn external_event() -> Json {
    json!({
        "id": "ext-1", "sourceId": "src-work", "remoteEventId": "g-1", "title": "Design review",
        "startAt": "2026-09-24T07:00:00.000Z", "endAt": "2026-09-24T08:30:00.000Z",
        "isAllDay": false, "status": "confirmed", "clock": {"peer": 1},
        "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    })
}

/// A parent and its child pulled live in one page.
async fn pull_live(
    device: &Device,
    (parent_type, parent_id, parent): (&str, &str, Json),
    (child_type, child_id, child): (&str, &str, Json),
) {
    device.payloads.set(parent_id, parent);
    device.payloads.set(child_id, child);
    device
        .run_page(
            vec![
                envelope(parent_id, parent_type),
                envelope(child_id, child_type),
            ],
            "10",
        )
        .await;
}

/// The parent's tombstone pulled without the child's, as when a peer's
/// cascade never reached the server. The orphan repair re-fetches the child,
/// which the server still holds unchanged.
async fn pull_parent_tombstone(device: &Device, parent: (&str, &str), child: (&str, &str)) {
    let (parent_type, parent_id) = parent;
    let (child_type, child_id) = child;
    device.script(&[
        json!({"items": [{"id": parent_id, "type": parent_type}], "deleted": [],
               "hasMore": false, "nextCursor": "11"})
        .to_string(),
        items(vec![tombstone(parent_id, parent_type)]),
        items(vec![envelope(child_id, child_type)]),
    ]);
    let report = device.pull.run(5).await.expect("the run");
    assert_eq!(report.deleted, 1, "the parent's tombstone applied");
    assert_eq!(
        device.pulled_ids().last(),
        Some(&json!([child_id])),
        "the child is fetched again before the check"
    );
}

#[tokio::test]
async fn a_task_whose_project_is_a_tombstone_here_is_tombstoned_and_its_delete_queued() {
    let device = device();
    pull_live(
        &device,
        ("project", "p1", project()),
        ("task", "t1", task("p1")),
    )
    .await;
    assert!(device.queued("task", "t1").is_empty());

    pull_parent_tombstone(&device, ("project", "p1"), ("task", "t1")).await;

    assert!(device.deleted_at("project", "p1").is_some());
    assert!(
        device.deleted_at("task", "t1").is_some(),
        "the orphan is tombstoned"
    );
    assert_eq!(device.queued("task", "t1"), vec!["delete"]);
}

#[tokio::test]
async fn a_message_whose_conversation_is_a_tombstone_here_is_tombstoned_and_its_delete_queued() {
    let device = device();
    pull_live(
        &device,
        ("agent_conversation", "conv-1", conversation()),
        ("agent_message", "m1", message("conv-1")),
    )
    .await;

    pull_parent_tombstone(
        &device,
        ("agent_conversation", "conv-1"),
        ("agent_message", "m1"),
    )
    .await;

    assert!(device.deleted_at("agent_message", "m1").is_some());
    assert_eq!(device.queued("agent_message", "m1"), vec!["delete"]);
}

#[tokio::test]
async fn an_external_event_whose_source_is_a_tombstone_here_is_tombstoned_and_its_delete_queued() {
    let device = device();
    pull_live(
        &device,
        ("calendar_source", "src-work", source()),
        ("calendar_external_event", "ext-1", external_event()),
    )
    .await;

    pull_parent_tombstone(
        &device,
        ("calendar_source", "src-work"),
        ("calendar_external_event", "ext-1"),
    )
    .await;

    assert!(
        device
            .deleted_at("calendar_external_event", "ext-1")
            .is_some()
    );
    assert_eq!(
        device.queued("calendar_external_event", "ext-1"),
        vec!["delete"]
    );
}

#[tokio::test]
async fn a_child_with_a_change_queued_is_left_to_that_change() {
    let device = device();
    pull_live(
        &device,
        ("project", "p1", project()),
        ("task", "t1", task("p1")),
    )
    .await;
    device
        .db
        .call_blocking(|conn| {
            let tx = conn.unchecked_transaction().map_err(failed)?;
            outbox::enqueue(&tx, &Change::upsert("task", "t1"), NOW)?;
            tx.commit().map_err(failed)
        })
        .expect("a queued edit");

    pull_parent_tombstone(&device, ("project", "p1"), ("task", "t1")).await;

    assert_eq!(
        device.deleted_at("task", "t1"),
        None,
        "the queued edit decides"
    );
    assert_eq!(device.queued("task", "t1"), vec!["upsert"]);
}

/// A parent the server does not return is not gone: absence carries no
/// clock (chapter 05 §5.12.3). Electron's default `inbox` project is never a
/// record, and its tasks must stay.
#[tokio::test]
async fn a_task_whose_project_is_only_absent_is_kept_and_the_project_fetched_once() {
    let device = device();
    device.payloads.set("t1", task("inbox"));
    device.payloads.set("t2", task("inbox"));
    // The page, its body, then the absent parent's fetch: the server has none.
    device.script(&[
        json!({"items": [{"id": "t1", "type": "task"}], "deleted": [],
               "hasMore": false, "nextCursor": "10"})
        .to_string(),
        items(vec![envelope("t1", "task")]),
        items(Vec::new()),
    ]);
    device.pull.run(5).await.expect("the first run");
    assert_eq!(device.pulled_ids(), vec![json!(["t1"]), json!(["inbox"])]);

    // A second delivering run of the same loop does not ask again; an
    // unscripted request would panic the fake transport.
    device.run_page(vec![envelope("t2", "task")], "11").await;

    assert_eq!(device.pulled_ids().len(), 3, "the parent was fetched once");
    for id in ["t1", "t2"] {
        assert_eq!(device.deleted_at("task", id), None, "{id} is kept");
        assert!(device.queued("task", id).is_empty(), "no delete for {id}");
    }
}

#[tokio::test]
async fn a_message_whose_conversation_is_absent_fetches_it_by_id_and_applies_it() {
    let device = device();
    device.payloads.set("m1", message("conv-1"));
    device.payloads.set("conv-1", conversation());
    device.script(&[
        json!({"items": [{"id": "m1", "type": "agent_message"}], "deleted": [],
               "hasMore": false, "nextCursor": "10"})
        .to_string(),
        items(vec![envelope("m1", "agent_message")]),
        items(vec![envelope("conv-1", "agent_conversation")]),
    ]);
    device.pull.run(5).await.expect("the run");

    assert_eq!(device.pulled_ids(), vec![json!(["m1"]), json!(["conv-1"])]);
    assert_eq!(device.deleted_at("agent_conversation", "conv-1"), None);
    assert_eq!(device.deleted_at("agent_message", "m1"), None);
}
