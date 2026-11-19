//! A claim costs VM steps linear in the outbox, however many deletes are queued: the
//! parent-delete hold (`sync::outbox::claim`) is decided once per claim, never by a scan
//! of the outbox per queued delete. Counted in SQLite VM steps, not milliseconds.

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::sync::outbox;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{Connection, params};

const DELETES: usize = 3_000;

static VM_STEPS: AtomicUsize = AtomicUsize::new(0);

fn count(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, _) = event {
        let steps = statement.get_status(rusqlite::StatementStatus::VmStep);
        VM_STEPS.fetch_add(usize::try_from(steps).unwrap_or(0), Ordering::SeqCst);
    }
}

#[test]
fn a_claim_over_thousands_of_queued_deletes_takes_linear_steps() {
    let mut conn = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut conn, DATA_MIGRATIONS).expect("data migrations");
    let tx = conn.transaction().expect("tx");
    for i in 0..DELETES {
        tx.execute(
            "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', ?1, 'delete', 1)",
            params![format!("n{i}")],
        )
        .expect("a queued note delete");
    }
    tx.execute(
        "INSERT INTO outbox (item_type, item_id, op, enqueued_at)
         VALUES ('project', 'p1', 'delete', 1), ('task', 't1', 'upsert', 1)",
        [],
    )
    .expect("a held project delete and its task row");
    tx.commit().expect("commit");

    VM_STEPS.store(0, Ordering::SeqCst);
    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(count));
    let claimed = outbox::claim(&conn, 2, 100, &[], &[]).expect("the claim");
    let pending = outbox::pending(&conn, 2).expect("the count");
    conn.trace_v2(TraceEventCodes::empty(), None);
    let steps = VM_STEPS.load(Ordering::SeqCst);

    assert_eq!(claimed.len(), 100);
    assert!(
        claimed.iter().all(|row| row.item_id != "p1"),
        "the delete is held"
    );
    // A scan per queued delete is about DELETES² steps (millions); one pass is a few
    // hundred per row.
    assert!(
        steps <= 200 * DELETES,
        "{steps} VM steps for {DELETES} deletes"
    );
    assert_eq!(pending, DELETES + 1, "the held delete is not pending");
}
