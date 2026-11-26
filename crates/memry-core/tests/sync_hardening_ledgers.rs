//! The desktop ledgers (Step 17 L3a, #3534) through the real pull: a record
//! whose signature does not verify is quarantined and, after three failures,
//! skipped undecoded; a row held corrupt for an hour is refetched at the start
//! of a run. Both run only in a pull built `PullLoop::with_hardening`
//! (decision K2): the same pages through an unhardened pull, as iOS's
//! `sync_now` builds it, leave no ledger and refetch nothing.
//!
//! Real `HttpClient`, SQLite and repositories; the transport and the record
//! cipher are the only fakes. The hour of cooldown is played by backdating
//! `sync_items.corrupt_at`.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use http_fakes::{FakeTransport, body_json, response};
use memry_core::domain::sticky_draft;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::driver::{
    AppliedRecord, ApplyObserver, CorruptItem, Observers, SecurityWarning,
};
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use serde_json::{Value as Json, json};

const TYPE: &str = "sticky_draft";
const SIGNER: &str = "device-b";
const MINUTE_MS: i64 = 60_000;

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-hardening-ledgers-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// What the cipher does with each envelope.
#[derive(Clone, Copy)]
enum Opens {
    /// Every envelope opens to a payload this build accepts.
    Accepted,
    /// Every signature fails.
    BadSignature,
    /// Every envelope is malformed: corrupt, but not a signature failure.
    Malformed,
}

struct FakeCipher(Opens);

impl RecordCipher for FakeCipher {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        match self.0 {
            Opens::Accepted => Ok(json!({
                "content": "from the peer", "kind": "note", "clock": {"peer": 1}
            })
            .to_string()
            .into_bytes()),
            Opens::BadSignature => Err(EnvelopeError::SignatureInvalid),
            Opens::Malformed => Err(EnvelopeError::Malformed {
                what: "a truncated blob".to_owned(),
            }),
        }
    }
}

/// Every quarantine, and each corrupt and recovered row as `corrupt <id>`
/// or `recovered <id>`.
#[derive(Default)]
struct Warnings(Mutex<Vec<SecurityWarning>>, Mutex<Vec<String>>);

impl ApplyObserver for Warnings {
    fn name(&self) -> &'static str {
        "warnings"
    }

    fn security_warning(&self, warning: &SecurityWarning) {
        self.0.lock().unwrap().push(warning.clone());
    }

    fn item_corrupt(&self, item: &CorruptItem) {
        assert!(!item.reason.is_empty(), "{item:?}");
        let mark = format!("corrupt {}", item.item_id);
        self.1.lock().unwrap().push(mark);
    }

    fn item_recovered(&self, record: &AppliedRecord) {
        let mark = format!("recovered {}", record.item_id);
        self.1.lock().unwrap().push(mark);
    }
}

impl Warnings {
    fn marks(&self) -> Vec<String> {
        self.1.lock().unwrap().clone()
    }

    fn attempts(&self) -> Vec<(i64, bool)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|warning| (warning.attempt_count, warning.permanent))
            .collect()
    }
}

fn envelope(id: &str) -> Json {
    json!({
        "id": id, "type": TYPE, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": SIGNER,
    })
}

fn changes(ids: &[&str], next_cursor: &str) -> String {
    let items: Vec<Json> = ids
        .iter()
        .map(|id| json!({"id": id, "type": TYPE}))
        .collect();
    json!({"items": items, "deleted": [], "hasMore": false, "nextCursor": next_cursor}).to_string()
}

fn pulled(ids: &[&str]) -> String {
    let items: Vec<Json> = ids.iter().map(|id| envelope(id)).collect();
    json!({ "items": items }).to_string()
}

/// The page every quarantine run pulls: the one item, listed and fetched.
fn page_of(id: &str, cursor: &str) -> Vec<String> {
    vec![changes(&[id], cursor), pulled(&[id])]
}

struct Run<'a> {
    db: &'a Db,
    hardened: bool,
    opens: Opens,
    warnings: Option<Arc<Warnings>>,
}

impl Run<'_> {
    async fn first_page(&self, script: Vec<String>) -> (PullReport, Arc<FakeTransport>) {
        let transport = FakeTransport::new(script.iter().map(|body| response(200, body)).collect());
        let http = HttpClient::new(
            transport.clone(),
            "https://sync.example",
            ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
        );
        let mut pull = PullLoop::new(
            Arc::new(http),
            self.db.clone(),
            Declaration::declare(&["note", TYPE]).expect("recognised"),
            Arc::new(FakeCipher(self.opens)),
        );
        if self.hardened {
            pull = pull.with_hardening();
        }
        if let Some(warnings) = &self.warnings {
            let observers = Arc::new(Observers::default());
            observers.register(warnings.clone());
            pull = pull.with_observers(observers);
        }
        let report = pull.pull_first_page().await.expect("the page");
        (report, transport)
    }
}

fn hardened(db: &Db, opens: Opens) -> Run<'_> {
    Run {
        db,
        hardened: true,
        opens,
        warnings: None,
    }
}

fn unhardened(db: &Db, opens: Opens) -> Run<'_> {
    Run {
        db,
        hardened: false,
        opens,
        warnings: None,
    }
}

fn quarantine_rows(db: &Db) -> Vec<(String, i64)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT item_id, attempt_count FROM sync_quarantine ORDER BY item_id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("read");
        Ok(rows)
    })
    .expect("read")
}

fn corrupt_at(db: &Db, id: &str) -> Option<i64> {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        Ok(conn
            .query_row(
                "SELECT corrupt_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [TYPE, id.as_str()],
                |row| row.get(0),
            )
            .expect("the row"))
    })
    .expect("read")
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("after the epoch")
            .as_millis(),
    )
    .expect("fits")
}

/// Plays `minutes` passing since the row was marked corrupt.
fn corrupt_since(db: &Db, id: &str, minutes: i64) {
    let (id, at) = (id.to_owned(), now_ms() - minutes * MINUTE_MS);
    db.call_blocking(move |conn| {
        let changed = conn
            .execute(
                "UPDATE sync_items SET corrupt_at = ?1 WHERE item_type = ?2 AND item_id = ?3",
                rusqlite::params![at, TYPE, id],
            )
            .expect("backdate");
        assert_eq!(changed, 1, "the corrupt row exists");
        Ok(())
    })
    .expect("write");
}

fn content(db: &Db, id: &str) -> Option<String> {
    let id = id.to_owned();
    db.call_blocking(move |conn| sticky_draft::get(conn, &id))
        .expect("read")
        .map(|draft| draft.content)
}

/// A row the pull marked corrupt (a malformed envelope, not a signature).
async fn corrupt_row(db: &Db, id: &str) {
    let (report, _) = hardened(db, Opens::Malformed)
        .first_page(page_of(id, "10"))
        .await;
    assert_eq!(report.corrupt, 1);
    assert!(corrupt_at(db, id).is_some());
    assert!(quarantine_rows(db).is_empty(), "not a signature failure");
}

/// Three hardened pulls of a bad signature: the item is permanent.
async fn quarantined_for_good(db: &Db, id: &str) {
    for cursor in ["10", "11", "12"] {
        hardened(db, Opens::BadSignature)
            .first_page(page_of(id, cursor))
            .await;
    }
    assert_eq!(quarantine_rows(db), vec![(id.to_owned(), 3)]);
}

#[tokio::test]
async fn a_bad_signature_is_quarantined_three_times_then_skipped_undecoded() {
    let db = scratch_db();
    let warnings = Arc::new(Warnings::default());
    let id = "draft-forged";
    let mut reports = Vec::new();
    for cursor in ["10", "11", "12", "13"] {
        let run = Run {
            warnings: Some(warnings.clone()),
            ..hardened(&db, Opens::BadSignature)
        };
        let (report, _) = run.first_page(page_of(id, cursor)).await;
        reports.push((report.corrupt, report.skipped));
    }

    assert_eq!(
        reports,
        vec![(1, 0), (1, 0), (1, 0), (0, 1)],
        "the fourth pull skips the item undecoded"
    );
    assert_eq!(
        warnings.attempts(),
        vec![(1, false), (2, false), (3, true)],
        "one warning per failure, the third permanent, none for the skip"
    );
    assert_eq!(warnings.marks(), vec![format!("corrupt {id}"); 3]);
    assert_eq!(quarantine_rows(&db), vec![(id.to_owned(), 3)]);
    assert_eq!(content(&db, id), None, "nothing forged reached the vault");
}

#[tokio::test]
async fn an_unhardened_pull_keeps_no_quarantine_and_never_skips() {
    let db = scratch_db();
    let warnings = Arc::new(Warnings::default());
    let id = "draft-forged";
    for cursor in ["10", "11", "12", "13"] {
        let run = Run {
            warnings: Some(warnings.clone()),
            ..unhardened(&db, Opens::BadSignature)
        };
        let (report, _) = run.first_page(page_of(id, cursor)).await;
        assert_eq!((report.corrupt, report.skipped), (1, 0));
    }

    assert!(quarantine_rows(&db).is_empty());
    assert!(warnings.attempts().is_empty());
}

#[tokio::test]
async fn a_row_corrupt_for_an_hour_is_refetched_first_and_applies() {
    let db = scratch_db();
    let id = "draft-repaired";
    corrupt_row(&db, id).await;
    corrupt_since(&db, id, 61);

    let script = vec![pulled(&[id]), changes(&[], "11")];
    let (_, transport) = hardened(&db, Opens::Accepted).first_page(script).await;

    let calls = transport.calls();
    assert!(
        calls[0].url.ends_with("/sync/pull"),
        "the refetch comes first"
    );
    assert_eq!(body_json(&calls[0]), json!({ "itemIds": [id] }));
    assert_eq!(content(&db, id).as_deref(), Some("from the peer"));
    assert_eq!(
        corrupt_at(&db, id),
        None,
        "the applied row is no longer corrupt"
    );
}

#[tokio::test]
async fn a_corrupt_row_tells_item_corrupt_and_its_applied_refetch_item_recovered() {
    let db = scratch_db();
    let warnings = Arc::new(Warnings::default());
    let id = "draft-repaired";
    let observed = |opens| Run {
        warnings: Some(warnings.clone()),
        ..hardened(&db, opens)
    };
    observed(Opens::Malformed)
        .first_page(page_of(id, "10"))
        .await;
    corrupt_since(&db, id, 61);
    // Refetched and still corrupt: corrupt again, not recovered.
    observed(Opens::Malformed)
        .first_page(vec![pulled(&[id]), changes(&[], "11")])
        .await;
    corrupt_since(&db, id, 61);
    observed(Opens::Accepted)
        .first_page(vec![pulled(&[id]), changes(&[], "12")])
        .await;

    assert_eq!(
        warnings.marks(),
        [
            format!("corrupt {id}"),
            format!("corrupt {id}"),
            format!("recovered {id}")
        ]
    );
    assert!(warnings.attempts().is_empty(), "not a signature failure");
    assert_eq!(content(&db, id).as_deref(), Some("from the peer"));
}

#[tokio::test]
async fn a_row_still_cooling_down_is_not_refetched() {
    let db = scratch_db();
    let id = "draft-repaired";
    corrupt_row(&db, id).await;
    corrupt_since(&db, id, 59);

    let (_, transport) = hardened(&db, Opens::Accepted)
        .first_page(vec![changes(&[], "11")])
        .await;

    assert!(transport.calls_to("/sync/pull").is_empty(), "cooling down");
    assert!(corrupt_at(&db, id).is_some());
}

#[tokio::test]
async fn an_unhardened_pull_never_refetches_a_corrupt_row() {
    let db = scratch_db();
    let id = "draft-repaired";
    corrupt_row(&db, id).await;
    corrupt_since(&db, id, 61);

    let (_, transport) = unhardened(&db, Opens::Accepted)
        .first_page(vec![changes(&[], "11")])
        .await;

    assert!(transport.calls_to("/sync/pull").is_empty());
    assert!(corrupt_at(&db, id).is_some());
}

#[tokio::test]
async fn a_permanently_quarantined_row_is_not_refetched() {
    let db = scratch_db();
    let id = "draft-forged";
    quarantined_for_good(&db, id).await;
    corrupt_since(&db, id, 61);

    let (_, transport) = hardened(&db, Opens::Accepted)
        .first_page(vec![changes(&[], "13")])
        .await;

    assert!(transport.calls_to("/sync/pull").is_empty());
    assert_eq!(content(&db, id), None);
}

#[tokio::test]
async fn only_the_corrupt_rows_past_the_cooldown_are_refetched() {
    let db = scratch_db();
    for id in ["draft-old", "draft-new"] {
        corrupt_row(&db, id).await;
    }
    corrupt_since(&db, "draft-old", 61);
    corrupt_since(&db, "draft-new", 10);

    let script = vec![pulled(&["draft-old"]), changes(&[], "11")];
    let (_, transport) = hardened(&db, Opens::Accepted).first_page(script).await;

    let refetch = transport.calls_to("/sync/pull");
    assert_eq!(refetch.len(), 1);
    assert_eq!(body_json(&refetch[0]), json!({ "itemIds": ["draft-old"] }));
    assert!(corrupt_at(&db, "draft-new").is_some());
}

/// An entry another build left in `sync_refused_items`, due for retry now.
fn refused_by_another_build(db: &Db, id: &str) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
             VALUES (?1, ?2, 'an-older-build', 0)",
            [TYPE, id.as_str()],
        )
        .expect("ledger");
        Ok(())
    })
    .expect("write");
}

#[tokio::test]
async fn a_permanently_quarantined_refused_item_is_not_refetched() {
    let db = scratch_db();
    let id = "draft-forged";
    quarantined_for_good(&db, id).await;
    refused_by_another_build(&db, id);

    let (_, transport) = hardened(&db, Opens::Accepted)
        .first_page(vec![changes(&[], "13")])
        .await;

    assert!(transport.calls_to("/sync/pull").is_empty());
    assert_eq!(content(&db, id), None, "never re-applied by any path");
}

#[tokio::test]
async fn a_bad_signature_on_a_refused_refetch_is_quarantined() {
    let db = scratch_db();
    let id = "draft-refused";
    refused_by_another_build(&db, id);
    let warnings = Arc::new(Warnings::default());
    let run = Run {
        warnings: Some(warnings.clone()),
        ..hardened(&db, Opens::BadSignature)
    };

    let (_, transport) = run
        .first_page(vec![pulled(&[id]), changes(&[], "11")])
        .await;

    assert_eq!(
        body_json(&transport.calls_to("/sync/pull")[0]),
        json!({ "itemIds": [id] })
    );
    assert_eq!(quarantine_rows(&db), vec![(id.to_owned(), 1)]);
    assert_eq!(warnings.attempts(), vec![(1, false)]);
}
