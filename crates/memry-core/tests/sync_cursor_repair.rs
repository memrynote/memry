//! The one-time cursor-skip repair (#2382, #2304): an install that synced
//! before the server assigned cursors in commit order (#2282) re-reads the
//! record feed once.
//!
//! Desktop's `cursorSkipRepair` shape: absent, `pending:<cursor>`, `done`.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pull::{
    META_CURSOR_SKIP_REPAIR, META_RECORD_DECLARATION, PullLoop, RecordCipher,
};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::json;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-cursor-repair-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct NoRecords;

impl RecordCipher for NoRecords {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// An empty page: no refs, so no `/sync/pull`.
fn page(
    next_cursor: i64,
    has_more: bool,
) -> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": has_more, "nextCursor": next_cursor})
            .to_string(),
    )
}

fn pull(db: &Db, transport: Arc<FakeTransport>) -> PullLoop {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoRecords),
    )
}

/// A device that has pulled under today's declaration, with `repair` as its
/// repair state.
fn seed(db: &Db, cursor: Option<&str>, repair: Option<&str>) {
    let cursor = cursor.map(str::to_owned);
    let repair = repair.map(str::to_owned);
    db.call_blocking(move |conn| {
        if let Some(cursor) = &cursor {
            store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some(cursor), 1)?;
        }
        let failed = |error: rusqlite::Error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        };
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            [
                META_RECORD_DECLARATION,
                Declaration::subscribed().header_value().as_str(),
            ],
        )
        .map_err(failed)?;
        if let Some(repair) = &repair {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [META_CURSOR_SKIP_REPAIR, repair.as_str()],
            )
            .map_err(failed)?;
        }
        Ok(())
    })
    .expect("seed the device");
}

fn repair_state(db: &Db) -> Option<String> {
    db.call_blocking(|conn| read_meta(conn, META_CURSOR_SKIP_REPAIR))
        .expect("read the repair state")
}

fn stored_cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

fn urls(transport: &FakeTransport) -> Vec<String> {
    transport.calls().into_iter().map(|call| call.url).collect()
}

/// #2382: a device holding a cursor from before the fix re-reads the feed
/// from the start once, and records `done` after the run that delivered.
#[tokio::test]
async fn an_install_with_a_cursor_re_pulls_the_feed_once_and_records_done() {
    let db = scratch_db("once");
    seed(&db, Some("500"), None);

    let transport = FakeTransport::new(vec![page(505, false), page(510, false)]);
    let pull = pull(&db, transport.clone());

    let first = pull.run(5).await.expect("the repair run");
    assert!(!first.refused);
    assert_eq!(repair_state(&db).as_deref(), Some("done"));
    assert_eq!(stored_cursor(&db).as_deref(), Some("505"));

    pull.run(5).await.expect("the next run");
    assert_eq!(
        urls(&transport),
        [
            // From the start: no cursor, so no inline either (§5.11.2).
            "https://sync.example/sync/changes?limit=500",
            "https://sync.example/sync/changes?limit=500&cursor=505&inline=1",
        ]
    );
}

/// #2382: an interrupted repair stays pending, resumes from the cursor it
/// stored, and never resets again; `done` waits for the end of the feed.
#[tokio::test]
async fn a_pending_repair_resumes_from_the_stored_cursor_and_never_resets_again() {
    let db = scratch_db("resume");
    seed(&db, Some("500"), None);

    let transport = FakeTransport::new(vec![page(100, true), page(200, false)]);
    let pull = pull(&db, transport.clone());

    let cut = pull.run(1).await.expect("a run cut short");
    assert!(cut.has_more);
    assert_eq!(repair_state(&db).as_deref(), Some("pending:500"));
    assert_eq!(stored_cursor(&db).as_deref(), Some("100"));

    pull.run(5).await.expect("the resumed run");
    assert_eq!(
        urls(&transport),
        [
            "https://sync.example/sync/changes?limit=500",
            "https://sync.example/sync/changes?limit=500&cursor=100&inline=1",
        ],
        "the resumed run reads on from 100, not from the start"
    );
    assert_eq!(repair_state(&db).as_deref(), Some("done"));
}

/// #2382: a device with no cursor reads the whole feed anyway, so there is
/// nothing to repair.
#[tokio::test]
async fn a_fresh_install_goes_straight_to_done() {
    let db = scratch_db("fresh");
    seed(&db, None, None);

    let transport = FakeTransport::new(vec![page(7, true)]);
    pull(&db, transport).run(1).await.expect("a first page");

    assert_eq!(
        repair_state(&db).as_deref(),
        Some("done"),
        "recorded before the first page, whatever it answers"
    );
}

/// #2382: a device whose repair is done is never reset again.
#[tokio::test]
async fn a_done_repair_leaves_the_cursor_alone() {
    let db = scratch_db("done");
    seed(&db, Some("500"), Some("done"));

    let transport = FakeTransport::new(vec![page(505, false)]);
    pull(&db, transport.clone())
        .run(1)
        .await
        .expect("an incremental run");

    assert_eq!(
        urls(&transport),
        ["https://sync.example/sync/changes?limit=500&cursor=500&inline=1"]
    );
}
