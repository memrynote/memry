//! A search index beside a `data.db`, and a gate that moves its watermark
//! while a writer waits for `data.db` (#5849).
//!
//! The incremental reindex selects rows stamped at or after its watermark,
//! the largest stamp the last pass saw. A writer that takes its stamp before
//! it holds `data.db` can commit rows below a watermark a reindex wrote while
//! it waited, and the next pass skips them.
//!
//! The gate holds `data.db` until a writer is parked on it
//! ([`Db::waiting`]), waits for the next wall-clock millisecond, then lands
//! another note and reindexes. Any stamp the writer took before it parked is
//! below that note's stamp, so the watermark passes it every time.
//!
//! Each test binary compiles this module separately, so a helper only one of
//! them needs is dead code in the other.

#![allow(dead_code)]

use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::api::errors::{StorageError, TransportError};
use memry_core::domain::search::{self, NOTES_WATERMARK_KEY, Reindexed};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::storage::migrations::{self, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;
use serde_json::json;

use super::http_fakes::FakeTransport;

/// The note the gate lands to move the watermark.
pub const RIVAL_NOTE: &str = "rival0note00";

pub fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_millis() as i64
}

pub fn note_payload(title: &str) -> String {
    json!({
        "title": title,
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-b": 1}
    })
    .to_string()
}

/// A pulled note record, applied at `at` (its `synced_at`).
pub fn land_note(conn: &Connection, id: &str, title: &str, at: i64) -> Result<(), StorageError> {
    let record = InboundRecord {
        item_type: "note".to_owned(),
        item_id: id.to_owned(),
        payload_json: note_payload(title),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: at,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, at).map(|_| ())
}

/// An `index.db` kept beside `data`, built once at creation.
#[derive(Clone)]
pub struct Search {
    data: Db,
    index: Arc<Mutex<Connection>>,
}

impl Search {
    pub fn new(data: &Db) -> Self {
        let mut index = Connection::open_in_memory().expect("index.db");
        migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
        let search = Self {
            data: data.clone(),
            index: Arc::new(Mutex::new(index)),
        };
        search.reindex();
        search
    }

    /// One incremental reindex.
    pub fn reindex(&self) -> Reindexed {
        let index = Arc::clone(&self.index);
        self.data
            .call_blocking(move |conn| search::reindex(conn, &index.lock().unwrap(), wall_ms()))
            .expect("reindex")
    }

    pub fn indexed(&self, id: &str) -> bool {
        self.count("SELECT count(*) FROM fts_notes WHERE id = ?1", id) > 0
    }

    /// Whether a note whose indexed text holds `word` is `id`.
    pub fn finds(&self, word: &str, id: &str) -> bool {
        let index = self.index.lock().unwrap();
        let mut statement = index
            .prepare("SELECT id FROM fts_notes WHERE fts_notes MATCH ?1")
            .expect("prepare");
        let ids: Vec<String> = statement
            .query_map([word], |row| row.get(0))
            .expect("match")
            .map(|row| row.expect("an id"))
            .collect();
        ids.iter().any(|hit| hit == id)
    }

    pub fn watermark(&self) -> i64 {
        self.index
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM index_meta WHERE key = ?1",
                [NOTES_WATERMARK_KEY],
                |row| row.get::<_, String>(0),
            )
            .expect("the notes watermark")
            .parse()
            .expect("a numeric watermark")
    }

    fn count(&self, sql: &str, id: &str) -> i64 {
        self.index
            .lock()
            .unwrap()
            .query_row(sql, [id], |row| row.get(0))
            .expect("count")
    }

    /// Holds `data.db` on a thread and answers once it holds it. While
    /// holding it, waits for a writer to park on it, then lands
    /// [`RIVAL_NOTE`] a millisecond later and reindexes.
    pub fn gate(&self) -> Gate {
        let (held_tx, held_rx) = mpsc::channel();
        let (data, index) = (self.data.clone(), Arc::clone(&self.index));
        let thread = std::thread::spawn(move || {
            let parked = data.clone();
            data.call_blocking(move |conn| {
                held_tx.send(()).expect("report the hold");
                while parked.waiting() == 0 {
                    std::thread::yield_now();
                }
                let at = wall_ms();
                while wall_ms() <= at {
                    std::thread::yield_now();
                }
                land_note(conn, RIVAL_NOTE, "Rival", wall_ms())?;
                search::reindex(conn, &index.lock().unwrap(), wall_ms()).map(|_| ())
            })
            .expect("the gate's write and reindex");
        });
        held_rx.recv().expect("the gate holds data.db");
        Gate(thread)
    }
}

pub struct Gate(JoinHandle<()>);

impl Gate {
    pub fn join(self) {
        self.0.join().expect("the gate thread");
    }
}

/// A [`FakeTransport`] that starts the gate when it answers the first request
/// whose URL contains `at`: the writer's last await before its apply.
pub struct GatedTransport {
    inner: Arc<FakeTransport>,
    at: &'static str,
    search: Search,
    gate: Mutex<Option<Gate>>,
}

impl GatedTransport {
    pub fn new(inner: Arc<FakeTransport>, at: &'static str, search: &Search) -> Arc<Self> {
        Arc::new(Self {
            inner,
            at,
            search: search.clone(),
            gate: Mutex::new(None),
        })
    }

    /// Waits for the gate it started, which has then released `data.db`.
    pub fn join(&self) {
        self.gate
            .lock()
            .unwrap()
            .take()
            .expect("the gate started")
            .join();
    }
}

#[async_trait::async_trait]
impl Transport for GatedTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let hit = request.url.contains(self.at);
        let answer = self.inner.send(request).await;
        let mut gate = self.gate.lock().unwrap();
        if hit && gate.is_none() {
            *gate = Some(self.search.gate());
        }
        answer
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.inner.open_socket(request, listener)
    }
}
