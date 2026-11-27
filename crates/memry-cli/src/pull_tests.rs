//! `pull`'s record loop against a scripted server (REVIEW-5529 low 1).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{StorageError, TransportError};
use memry_core::domain::journal_ops::metadata;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound_on;
use memry_core::sync::pull::RecordCipher;
use serde_json::{Value, json};

use super::record_pull;

const NOW: i64 = 1_760_000_000_000;
const DAY: &str = "2026-11-23";
const ID: &str = "j2026-11-23";

struct Scripted(Mutex<VecDeque<String>>);

#[async_trait::async_trait]
impl Transport for Scripted {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let body = self.0.lock().unwrap().pop_front().expect("scripted");
        Ok(HttpResponse {
            status: 200,
            headers: Default::default(),
            body: body.into_bytes(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no socket".to_string(),
        })
    }
}

/// Opens every envelope to one payload.
struct Plain(String);

impl RecordCipher for Plain {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0.clone().into_bytes())
    }
}

fn vault(label: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("memry-cli-pull-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn pushed(db: &Db) -> String {
    db.call_blocking(|conn| sync_items::push_payload(conn, "journal", ID))
        .expect("read the row")
        .expect("a payload")
}

fn apply(db: &Db, payload: &str) {
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: ID.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    db.call_blocking(|conn| apply_inbound_on(conn, &record, NOW, Some("seed")))
        .expect("apply");
}

fn edit(db: &Db, tags: &[&str], property: Option<(&str, Value)>, device: &str) {
    let tags: Vec<String> = tags.iter().map(|tag| (*tag).to_owned()).collect();
    db.call_blocking(|conn| {
        metadata::set_tags(conn, DAY, &tags, device, NOW)?;
        if let Some((name, value)) = property {
            metadata::set_property(conn, DAY, name, value, device, NOW).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })?;
        }
        Ok(())
    })
    .expect("edit");
}

/// §6.12.3: a concurrent journal merge that re-queues is ticked for this
/// device. Without the device id the CLI pull recorded the item corrupt.
#[tokio::test]
async fn a_concurrent_journal_merge_that_requeues_is_stored() {
    let (origin, cli, desk) = (vault("origin"), vault("cli"), vault("desk"));
    edit(&origin, &["keep"], None, "dev-x");
    let base = pushed(&origin);
    apply(&cli, &base);
    apply(&desk, &base);
    edit(&cli, &["keep", "mine"], None, "dev-c");
    edit(&desk, &["keep"], Some(("k", json!(1))), "dev-d");

    let page = json!({
        "items": [{ "id": ID, "type": "journal" }],
        "deleted": [], "hasMore": false, "nextCursor": "1"
    });
    let envelope = json!({ "items": [{
        "id": ID, "type": "journal", "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "dev-d"
    }]});
    let transport = Arc::new(Scripted(Mutex::new(
        [page.to_string(), envelope.to_string()].into(),
    )));
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let report = record_pull(
        http,
        cli.clone(),
        Arc::new(Plain(pushed(&desk))),
        "v",
        "dev-c",
    )
    .pull_page()
    .await
    .expect("the page");

    assert_eq!((report.applied, report.corrupt), (1, 0), "{report:?}");
    let stored: Value = serde_json::from_str(&pushed(&cli)).expect("json");
    assert_eq!(stored["tags"], json!(["keep", "mine"]));
    assert_eq!(stored["properties"], json!({ "k": 1 }));
}
