//! A CRDT push batch stays inside the request payload budget.
//!
//! `POST /sync/crdt/updates` rides the `/sync/*` body ceiling of 8 MiB, and the
//! server answers 413 before any route runs when a body is past it
//! (`apps/sync-server/src/index.ts:66`). A note with many large pending updates
//! used to be claimed as one batch of up to 100 rows with no byte cap: the 413
//! neither retired nor deferred a row, so every wave failed at that batch and
//! nothing behind it was ever sent. A batch is now cut at
//! `MAX_REQUEST_PAYLOAD_CHARS` of base64, the number desktop uses.
//!
//! Real SQLite, real `HttpClient`, real packed envelopes. The transport plays
//! the server's one relevant rule: a body past the ceiling is a 413.

mod http_fakes;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use http_fakes::response;
use memry_core::api::errors::TransportError;
use memry_core::crypto::sodium;
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Batch, Change};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};
use zeroize::Zeroizing;

const SERVER_BODY_CEILING: usize = 8 * 1024 * 1024;

fn scratch_db() -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-outbox-batch-cap-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Seals with the production envelope, so the bytes sent are the real size.
struct PackSealer {
    vault_key: [u8; 32],
    secret_key: Zeroizing<Vec<u8>>,
}

impl PackSealer {
    fn new() -> Arc<Self> {
        let (_, secret_key) = sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
        Arc::new(Self {
            vault_key: [3u8; 32],
            secret_key,
        })
    }
}

impl PushSealer for PackSealer {
    fn seal_record(&self, _item: &PendingRecord) -> Result<Json, EnvelopeError> {
        unreachable!("this wave carries CRDT rows only")
    }

    fn seal_crdt_update(&self, doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        pack(
            &CrdtRequest {
                note_id: doc_id,
                update,
                vault_key: &self.vault_key,
                signing_secret_key: &self.secret_key,
            },
            &CrdtMaterial::random(),
        )
    }
}

/// The server's body ceiling and its `{ sequences }` answer, nothing else.
struct CeilingServer {
    bodies: Mutex<Vec<usize>>,
}

#[async_trait::async_trait]
impl Transport for CeilingServer {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let body = request.body.expect("a CRDT push has a body");
        self.bodies.lock().unwrap().push(body.len());
        if body.len() > SERVER_BODY_CEILING {
            return Ok(HttpResponse {
                status: 413,
                headers: HashMap::new(),
                body: Vec::new(),
            });
        }
        let parsed: Json = serde_json::from_slice(&body).expect("a JSON body");
        let count = parsed["updates"].as_array().map_or(0, Vec::len);
        let sequences: Vec<usize> = (1..=count).collect();
        response(200, &json!({ "sequences": sequences }).to_string())
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets here".to_string(),
        })
    }
}

/// A pseudo-random update, which deflate cannot shrink: the sealed size is the
/// plaintext size plus the frame, the case a size cap has to survive.
fn incompressible(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

fn enqueue_updates(db: &Db, doc_id: &str, sizes: &[usize]) {
    let doc_id = doc_id.to_owned();
    let sizes = sizes.to_vec();
    db.call_blocking(move |conn| {
        for (at, size) in sizes.iter().enumerate() {
            let update = incompressible(*size, at as u64 + 1);
            outbox::commit(
                conn,
                &Change::crdt_update("note", &doc_id, update),
                at as i64,
                |_| Ok(()),
            )?;
        }
        Ok(())
    })
    .expect("enqueue");
}

/// An update well under the per-update cap: 800 KB raw is about 1.09 million
/// base64 characters, so a request holds five and the sixth starts the next.
const UPDATE_BYTES: usize = 800 * 1024;

#[tokio::test]
async fn many_large_pending_updates_drain_under_the_body_ceiling() {
    let db = scratch_db();
    // Ten updates are 10.9 million characters: one request of them would pass
    // 8 MiB.
    enqueue_updates(&db, "n1", &[UPDATE_BYTES; 10]);
    // A second document behind it, to prove the queue is not stalled.
    enqueue_updates(&db, "n2", &[1024]);

    let server = Arc::new(CeilingServer {
        bodies: Mutex::new(Vec::new()),
    });
    let http = HttpClient::new(
        server.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let push = PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        PackSealer::new(),
    );

    let report = push.drain_wave().await.expect("the wave drains");

    assert_eq!(report.crdt_updates, 11, "every update was accepted");
    let bodies = server.bodies.lock().unwrap().clone();
    assert!(
        bodies.iter().all(|len| *len <= SERVER_BODY_CEILING),
        "a request exceeded the server's body ceiling: {bodies:?}"
    );
    assert_eq!(bodies.len(), 3, "n1 rides in two requests, n2 in one");
    let left = db
        .call_blocking(|conn| outbox::next_batch(conn, i64::MAX, 100))
        .expect("read the outbox");
    assert!(left.is_none(), "nothing is left queued, got {left:?}");
}

#[test]
fn a_batch_is_cut_at_the_request_budget_and_keeps_every_row_in_order() {
    let db = scratch_db();
    enqueue_updates(
        &db,
        "n1",
        &[
            UPDATE_BYTES,
            UPDATE_BYTES,
            UPDATE_BYTES,
            UPDATE_BYTES,
            UPDATE_BYTES,
            UPDATE_BYTES,
            100,
        ],
    );

    let batches: Vec<Vec<i64>> = std::iter::from_fn({
        let db = db.clone();
        move || {
            let batch = db
                .call_blocking(|conn| outbox::next_batch(conn, i64::MAX, 100))
                .expect("a batch")?;
            let Batch::Crdt { rows, .. } = batch else {
                panic!("only CRDT rows are queued");
            };
            let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
            let acked = ids.clone();
            db.call_blocking(move |conn| outbox::ack(conn, &acked))
                .expect("ack");
            Some(ids)
        }
    })
    .collect();

    // Five rows fill a request; the sixth and the small edit ride the next, in
    // the order they were enqueued.
    let lens: Vec<usize> = batches.iter().map(Vec::len).collect();
    assert_eq!(lens, vec![5, 2]);
    let flat: Vec<i64> = batches.concat();
    let mut sorted = flat.clone();
    sorted.sort_unstable();
    assert_eq!(flat, sorted, "enqueue order is preserved across batches");
}
