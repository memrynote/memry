//! The applied-record feed through the real pull (#3534 L2): every observer
//! hears one record per item of a committed page, and the row it is told
//! about is already readable from a reader connection.
//!
//! Real `HttpClient`, SQLite and apply; the transport and the record cipher
//! are the only fakes.

#[allow(unused_imports)]
use crate::http_fakes;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::driver::observer::{AppliedOutcome, AppliedRecord, ApplyObserver, Observers};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};

const TYPE: &str = "sticky_draft";
const NOW: i64 = 1_776_297_600_000;

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-applied-records-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Opens each envelope to the payload of its id.
struct Payloads(BTreeMap<String, String>);

impl RecordCipher for Payloads {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0[&envelope.id].as_bytes().to_vec())
    }
}

fn envelope_of(id: &str) -> Json {
    json!({
        "id": id, "type": TYPE, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
    })
}

/// Checks, from a reader connection, that every record it hears is stored.
struct Reader {
    name: &'static str,
    db: Db,
    heard: Mutex<Vec<(String, AppliedOutcome, bool)>>,
}

impl ApplyObserver for Reader {
    fn name(&self) -> &str {
        self.name
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        for record in batch {
            let (item_type, item_id) = (record.item_type.clone(), record.item_id.clone());
            let stored = self
                .db
                .read_blocking(move |conn| {
                    let row = sync_items::load(conn, &item_type, &item_id)?;
                    Ok(row.is_some_and(|row| row.payload.is_some()))
                })
                .expect("a reader connection");
            self.heard
                .lock()
                .unwrap()
                .push((record.item_id.clone(), record.outcome, stored));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_observers_hear_every_record_of_a_page_readable_after_it_commits() {
    let db = scratch_db();
    let local = db
        .call_blocking(|conn| {
            sticky_draft::upsert(conn, None, "mine", StickyKind::Note, "device-a", NOW)
        })
        .expect("a local draft")
        .id;
    let mut ids: Vec<String> = (0..9).map(|n| format!("sticky-{n}")).collect();
    ids.push(local.clone());
    let payloads = ids
        .iter()
        .map(|id| {
            let payload =
                json!({"content": format!("from {id}"), "kind": "note", "clock": {"device-a": 1, "peer": 1}});
            (id.clone(), payload.to_string())
        })
        .collect();
    let refs: Vec<Json> = ids
        .iter()
        .map(|id| json!({"id": id, "type": TYPE}))
        .collect();
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": refs, "deleted": [], "hasMore": false, "nextCursor": "10"})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": ids.iter().map(|id| envelope_of(id)).collect::<Vec<_>>()}).to_string(),
        ),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
    );
    let observers = Arc::new(Observers::default());
    let readers = ["first", "second"].map(|name| {
        let reader = Arc::new(Reader {
            name,
            db: db.clone(),
            heard: Mutex::default(),
        });
        observers.register(reader.clone());
        reader
    });
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::declare(&[TYPE]).expect("recognised"),
        Arc::new(Payloads(payloads)),
    )
    .with_observers(observers);

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.applied, 10);

    let expected: Vec<(String, AppliedOutcome, bool)> = ids
        .iter()
        .map(|id| {
            let outcome = if *id == local {
                AppliedOutcome::Updated
            } else {
                AppliedOutcome::Created
            };
            (id.clone(), outcome, true)
        })
        .collect();
    for reader in readers {
        assert_eq!(*reader.heard.lock().unwrap(), expected, "{}", reader.name);
    }
}
