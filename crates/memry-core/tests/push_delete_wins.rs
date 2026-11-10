//! A push the server refuses as already deleted or replayed (chapter 05 §5.7, §5.8), and when the
//! wave deletes the local record for it (#4025).
//!
//! | Test                                                    | Rule                               |
//! | ------------------------------------------------------- | ---------------------------------- |
//! | a learned definition refused as deleted is deleted here | §5.8 client rule, §5.12.3          |
//! | every other refusal leaves the local record live        | §5.7, §5.8: only a definition upsert |
//! | a user's create is sent as `create` and stays live       | §5.12.3 re-create over a marker    |
//! | an edit made while the refused push was in flight stays | the edit is pushed next            |

#[allow(unused_imports)]
use crate::http_fakes;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::domain::property_admin::learned;
use memry_core::domain::property_admin::records::{self, DefinitionRecord};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox;
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use rusqlite::params;
use serde_json::{Value as Json, json};

const DEFINITION: &str = "property_definition";
const NOW: i64 = 1_760_000_000_000;

fn scratch_db(label: &str) -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-delete-wins-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Records the wire operation of every record it seals.
#[derive(Default)]
struct Operations(Mutex<Vec<String>>);

impl PushSealer for Operations {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        let operation = item.operation.as_str().to_owned();
        self.0.lock().unwrap().push(operation.clone());
        Ok(json!({ "id": item.row.item_id, "type": item.row.item_type, "operation": operation }))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

fn refused(id: &str, reason: &str) -> Result<HttpResponse, TransportError> {
    response(
        200,
        &json!({
            "accepted": [],
            "rejected": [{ "id": id, "reason": reason }],
            "serverTime": 1,
            "maxCursor": 1,
        })
        .to_string(),
    )
}

fn push(db: &Db, transport: Arc<dyn Transport>, sealer: Arc<Operations>) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        sealer,
    )
}

fn record(type_name: &str) -> DefinitionRecord {
    DefinitionRecord {
        name: "gone".into(),
        type_name: type_name.into(),
        options: None,
        default_value: None,
        color: None,
    }
}

/// A learned type, promoted to a record and queued as an upsert, as the sync pass's seed does.
fn promoted(db: &Db) {
    db.call_blocking(|c| {
        let wanted = BTreeMap::from([("gone".to_owned(), "text".to_owned())]);
        assert!(learned::learn(c, &wanted)?);
        assert_eq!(
            learned::promote(c, &BTreeSet::new(), "device-a", NOW)?,
            ["gone"]
        );
        Ok(())
    })
    .expect("promote");
}

/// A live row and a queued `op` for it, written straight to the tables.
fn queued_row(db: &Db, item_type: &'static str, op: &'static str) {
    db.call_blocking(move |c| {
        c.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
             VALUES (?1, 'gone', '{}', 'full', '{\"device-a\":1}', 1)",
            params![item_type],
        )
        .map_err(failed)?;
        c.execute(
            "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES (?1, 'gone', ?2, 1)",
            params![item_type, op],
        )
        .map_err(failed)?;
        Ok(())
    })
    .expect("queue");
}

fn live(db: &Db, item_type: &'static str) -> bool {
    db.call_blocking(move |c| sync_items::load(c, item_type, "gone"))
        .expect("load")
        .is_some_and(|row| row.deleted_at.is_none())
}

fn queued(db: &Db) -> Vec<String> {
    db.call_blocking(|c| {
        let mut statement = c
            .prepare("SELECT op FROM outbox ORDER BY id")
            .map_err(failed)?;
        let ops = statement
            .query_map([], |row| row.get(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
            .map_err(failed)?;
        Ok(ops)
    })
    .expect("the outbox")
}

#[tokio::test]
async fn a_learned_definition_refused_as_deleted_is_deleted_here() {
    let db = scratch_db("learned");
    promoted(&db);
    let transport = FakeTransport::new(vec![refused("gone", "SYNC_DELETE_WINS")]);
    let sealer = Arc::new(Operations::default());
    push(&db, transport, Arc::clone(&sealer))
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(*sealer.0.lock().unwrap(), ["update"]);
    assert!(!live(&db, DEFINITION), "the delete wins here too");
    assert!(queued(&db).is_empty());
}

#[tokio::test]
async fn every_other_refusal_leaves_the_local_record_live() {
    let cases: [(&str, &str, &str); 3] = [
        ("tag_definition", outbox::OP_UPSERT, "SYNC_DELETE_WINS"),
        (DEFINITION, outbox::OP_DELETE, "SYNC_DELETE_WINS"),
        (DEFINITION, outbox::OP_UPSERT, "SYNC_REPLAY_DETECTED"),
    ];
    let mut kept = Vec::new();
    for (item_type, op, reason) in cases {
        let db = scratch_db("other");
        queued_row(&db, item_type, op);
        let transport = FakeTransport::new(vec![refused("gone", reason)]);
        push(&db, transport, Arc::new(Operations::default()))
            .drain_wave()
            .await
            .expect("the wave");
        assert!(queued(&db).is_empty(), "the refusal is terminal (§5.8)");
        if live(&db, item_type) {
            kept.push((item_type, op, reason));
        }
    }
    assert_eq!(kept, cases);
}

#[tokio::test]
async fn a_users_create_is_sent_as_create_and_stays_live_when_refused() {
    let db = scratch_db("create");
    db.call_blocking(|c| records::put(c, &record("number"), "device-a", NOW))
        .expect("create");
    assert_eq!(queued(&db), [outbox::OP_CREATE]);
    let transport = FakeTransport::new(vec![refused("gone", "SYNC_DELETE_WINS")]);
    let sealer = Arc::new(Operations::default());
    push(&db, transport, Arc::clone(&sealer))
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(*sealer.0.lock().unwrap(), ["create"]);
    assert!(live(&db, DEFINITION));
}

/// Edits `gone` while the first push of its record is in flight and answers `SYNC_DELETE_WINS`;
/// accepts the next push.
struct EditInFlight {
    db: Db,
    calls: Mutex<usize>,
}

#[async_trait::async_trait]
impl Transport for EditInFlight {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let call = std::mem::replace(&mut *self.calls.lock().unwrap(), 1);
        if call == 0 {
            self.db
                .call(|c| records::put(c, &record("number"), "device-a", NOW + 1))
                .await
                .expect("the edit");
            return refused("gone", "SYNC_DELETE_WINS");
        }
        let accepted =
            json!({ "accepted": ["gone"], "rejected": [], "serverTime": 1, "maxCursor": 1 });
        response(200, &accepted.to_string())
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".into(),
        })
    }
}

#[tokio::test]
async fn an_edit_made_while_the_refused_push_was_in_flight_is_kept_and_pushed_next() {
    let db = scratch_db("in-flight");
    promoted(&db);
    let transport = Arc::new(EditInFlight {
        db: db.clone(),
        calls: Mutex::new(0),
    });
    let sealer = Arc::new(Operations::default());
    push(&db, transport, Arc::clone(&sealer))
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(
        *sealer.0.lock().unwrap(),
        ["update", "update"],
        "the edit is pushed next"
    );
    let row = db
        .call_blocking(|c| sync_items::load(c, DEFINITION, "gone"))
        .expect("load")
        .expect("the record");
    assert!(row.deleted_at.is_none(), "the edit is not tombstoned");
    let payload: Json = serde_json::from_str(row.payload.as_deref().expect("a payload")).unwrap();
    assert_eq!(payload["type"], json!("number"));
    assert!(queued(&db).is_empty());
}
