//! The body step's `more_due` (#5235): a step its request budget cut short says
//! so, so a shell runs the next pass at once. A step that reached every due
//! document, or that a `429` ended, does not.
//!
//! Real `HttpClient`, SQLite and body step; the transport is the only fake.

use std::sync::Arc;

use crate::http_fakes::{self, FakeTransport};
use crate::support;
use memry_core::api::errors::StorageError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::body_step::{self, BODY_REQUEST_BUDGET};
use memry_core::sync::{body_debt, note_body_feed, store};

struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(
        &self,
        update: &PackedUpdate<'_>,
    ) -> Result<Vec<u8>, memry_core::protocol::envelope::EnvelopeError> {
        Ok(update.packed.to_vec())
    }
}

/// `owed` documents due, with the one-time heal already done.
fn owing(label: &str, owed: usize) -> (tempfile::TempDir, Db) {
    let dir = support::scratch_dir(&format!("body-step-budget-{label}"));
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        for index in 0..owed {
            let doc = format!("budget{index:06}");
            store::write_cursor(conn, &format!("crdt:{doc}"), Some("5"), 1)?;
            body_debt::owe(conn, &doc)?;
        }
        Ok(())
    })
    .expect("the debts");
    (dir, db)
}

/// A transport answering every request with `status`, more times than any step asks.
fn answering(status: u16) -> Arc<FakeTransport> {
    let transport = FakeTransport::new(Vec::new());
    for _ in 0..BODY_REQUEST_BUDGET * 2 {
        transport.push(http_fakes::error_response(status, "refused", "refused"));
    }
    transport
}

async fn step(db: &Db, transport: Arc<FakeTransport>) -> body_step::BodyStep {
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let pull = BodyPull::new(
        http,
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    );
    body_step::run(db, &pull).await.expect("the body step")
}

#[tokio::test]
async fn a_step_the_budget_cut_short_has_more_due() {
    let (_dir, db) = owing("over", BODY_REQUEST_BUDGET + 3);
    let step = step(&db, answering(400)).await;
    assert!(step.pulled.requests >= BODY_REQUEST_BUDGET, "{step:?}");
    assert!(step.more_due, "{step:?}");
}

#[tokio::test]
async fn a_step_that_reached_every_due_document_has_none_more_due() {
    let (_dir, db) = owing("under", 3);
    let step = step(&db, answering(400)).await;
    assert!(step.pulled.requests > 0, "{step:?}");
    assert!(!step.more_due, "{step:?}");
}

#[tokio::test]
async fn a_rate_limited_step_waits_for_its_retry_not_the_next_pass() {
    let (_dir, db) = owing("limited", BODY_REQUEST_BUDGET + 3);
    let step = step(&db, answering(429)).await;
    assert!(!step.more_due, "{step:?}");
}
