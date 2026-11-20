//! A body change is told to the observers once it committed, and only then
//! (`bodies_applied`): the desktop writes a note's file from it.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log;
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack, unpack};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate, crdt_cursor_scope};
use memry_core::sync::driver::observer::{ApplyObserver, Observers};
use memry_core::sync::store;
use serde_json::json;
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const NOTE: &str = "abc123def456";
const VAULT_KEY: [u8; 32] = [3u8; 32];

fn scratch_db(label: &str) -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-body-observers-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// The real §4.12 open over a directory of one device.
struct Directory {
    device_id: String,
    public_key: Vec<u8>,
}

impl CrdtCipher for Directory {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if update.signer_device_id != Some(self.device_id.as_str()) {
            return Err(EnvelopeError::SignatureInvalid);
        }
        unpack(update.packed, update.doc_id, &VAULT_KEY, &self.public_key)
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec![self.device_id.clone()]
    }
}

fn body_update(text: &str) -> Vec<u8> {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn packed(doc_id: &str, update: &[u8], secret_key: &[u8]) -> Vec<u8> {
    pack(
        &CrdtRequest {
            note_id: doc_id,
            update,
            vault_key: &VAULT_KEY,
            signing_secret_key: secret_key,
        },
        &CrdtMaterial::random(),
    )
    .expect("pack")
}

fn text_of(db: &Db, doc_id: &str) -> String {
    let id = doc_id.to_owned();
    let blobs: Vec<Vec<u8>> = db
        .call_blocking(move |conn| {
            update_log::load_plan(conn, &id)
                .map(|plan| plan.blobs().into_iter().map(<[u8]>::to_vec).collect())
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("load plan");
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-reader", sink)
        .get_or_open(doc_id)
        .expect("open");
    for blob in &blobs {
        document.apply_durable_update(blob).expect("apply");
    }
    extract_text(&document).expect("extract")
}

fn cursor_of(db: &Db, doc_id: &str) -> Option<String> {
    let scope = crdt_cursor_scope(doc_id);
    db.call_blocking(move |conn| store::read_cursor(conn, &scope))
        .expect("cursor")
}

struct BodyWatcher {
    db: Db,
    heard: std::sync::Mutex<Vec<(Vec<String>, Option<String>)>>,
}

impl ApplyObserver for BodyWatcher {
    fn name(&self) -> &str {
        "body-watcher"
    }

    fn bodies_applied(&self, doc_ids: &[String]) {
        let cursor = cursor_of(&self.db, &doc_ids[0]);
        self.heard.lock().unwrap().push((doc_ids.to_vec(), cursor));
    }
}

/// A pull whose first page committed an update and whose second page then fails (a `500` through
/// the whole retry ladder) still names the document: the stored update is in the database, so the
/// file must follow it, error or not.
#[tokio::test]
async fn a_failed_later_page_still_tells_the_observers_of_the_update_already_stored() {
    let db = scratch_db("observers-failed-page");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
    let update = BASE64.encode(packed(NOTE, &body_update("Page one"), &secret_key));
    let mut script = vec![
        response(200, &json!({"snapshot": null}).to_string()),
        response(
            200,
            &json!({"updates": [{"sequenceNum": 1, "data": update, "signerDeviceId": "device-a"}],
                    "hasMore": true})
            .to_string(),
        ),
    ];
    script.extend((0..4).map(|_| response(500, "{}")));
    let transport = FakeTransport::new(script);
    let http = Arc::new(
        HttpClient::new(
            transport,
            "https://sync.example",
            ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
        )
        .with_sleeper(http_fakes::RecordingSleeper::new()),
    );
    let observers = Arc::new(Observers::default());
    let watcher = Arc::new(BodyWatcher {
        db: db.clone(),
        heard: std::sync::Mutex::default(),
    });
    observers.register(watcher.clone());
    let bodies = BodyPull::new(
        http,
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory {
            device_id: "device-a".into(),
            public_key,
        }),
    )
    .with_observers(observers);

    assert!(bodies.pull_document(NOTE).await.is_err(), "page two failed");
    assert_eq!(text_of(&db, NOTE), "Page one");
    assert_eq!(
        *watcher.heard.lock().unwrap(),
        [(vec![NOTE.to_owned()], Some("1".to_owned()))],
        "the committed update is told although the pull failed"
    );
}
