//! A sync page's search stamps against a reindex that ran while the page
//! waited for `data.db` (#5849).
//!
//! The incremental reindex selects rows stamped at or after its watermark,
//! and the watermark is the largest stamp the last pass saw. A page that took
//! its stamp before it held `data.db` can commit rows below a watermark a
//! reindex wrote while the page waited, and the next pass skips them.
//!
//! Real `HttpClient`, SQLite, pull loop and reindex; the transport and the
//! record cipher are the only fakes.

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http_fakes::{FakeTransport, response};
use memry_core::domain::search;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::migrations::{self, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use rusqlite::Connection;
use serde_json::json;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const PAGE_NOTE: &str = "page0note000";
const RIVAL_NOTE: &str = "rival0note00";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-pull-search-stamp-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_millis() as i64
}

fn note_payload(title: &str) -> String {
    json!({
        "title": title,
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-b": 1}
    })
    .to_string()
}

fn reindex(data: &Db, index: &Arc<Mutex<Connection>>) {
    let index = Arc::clone(index);
    data.call_blocking(move |conn| {
        search::reindex(conn, &index.lock().unwrap(), wall_ms()).map(|_| ())
    })
    .expect("reindex");
}

fn indexed(index: &Arc<Mutex<Connection>>, id: &str) -> bool {
    index
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM fts_notes WHERE id = ?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .expect("read fts_notes")
        > 0
}

/// Opens the page's one record. Before it answers, it starts the gate: a
/// thread that holds `data.db` and, while holding it, lands another note
/// and runs a reindex, so the watermark moves while the page waits for the
/// lock to apply.
struct GatedCipher {
    data: Db,
    index: Arc<Mutex<Connection>>,
    gate: Mutex<Option<JoinHandle<()>>>,
}

impl RecordCipher for GatedCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        let (held_tx, held_rx) = mpsc::channel();
        let (data, index) = (self.data.clone(), Arc::clone(&self.index));
        let gate = std::thread::spawn(move || {
            data.call_blocking(move |conn| {
                held_tx.send(()).expect("report the hold");
                // Lower bound only: lets the page, now past its last await but
                // one, reach its apply and wait on this hold. The rival's
                // stamp is then a later millisecond than any stamp the page
                // took before the hold.
                std::thread::sleep(Duration::from_millis(50));
                let rival = InboundRecord {
                    item_type: "note".to_owned(),
                    item_id: RIVAL_NOTE.to_owned(),
                    payload_json: note_payload("Rival"),
                    server_cursor: Some(2),
                    signer_device_id: Some("device-a".to_owned()),
                    updated_at: wall_ms(),
                    deleted_at: None,
                };
                sync_items::apply_remote(conn, &rival, wall_ms())?;
                search::reindex(conn, &index.lock().unwrap(), wall_ms()).map(|_| ())
            })
            .expect("the gate's write and reindex");
        });
        held_rx.recv().expect("the gate holds data.db");
        *self.gate.lock().unwrap() = Some(gate);
        assert_eq!(envelope.id, PAGE_NOTE);
        Ok(note_payload("Paged").into_bytes())
    }
}

/// #5849: a page that waited on `data.db` while a reindex wrote its
/// watermark is indexed by the next incremental reindex.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_waiting_on_the_lock_through_a_reindex_is_indexed_next_pass() {
    let data = scratch_db("gate");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    let index = Arc::new(Mutex::new(index));
    reindex(&data, &index);

    let envelope = json!({
        "id": PAGE_NOTE,
        "type": "note",
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
    });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({
                "items": [{"id": PAGE_NOTE, "type": "note"}],
                "deleted": [],
                "hasMore": false,
                "nextCursor": "1",
            })
            .to_string(),
        ),
        response(200, &json!({ "items": [envelope] }).to_string()),
    ]);
    let cipher = Arc::new(GatedCipher {
        data: data.clone(),
        index: Arc::clone(&index),
        gate: Mutex::new(None),
    });
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        data.clone(),
        Declaration::subscribed(),
        Arc::clone(&cipher) as Arc<dyn RecordCipher>,
    );

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.applied, 1);
    let gate = cipher.gate.lock().unwrap().take().expect("the gate ran");
    gate.join().expect("the gate thread");

    // The gate's reindex ran and saw the rival.
    assert!(indexed(&index, RIVAL_NOTE));

    reindex(&data, &index);
    assert!(
        indexed(&index, PAGE_NOTE),
        "the next incremental reindex skipped the page's note"
    );
}
