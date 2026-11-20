//! The sync events besides the status, and what a pause does to the pass in flight.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, CorruptItem, SecurityWarning};
use tokio::time::sleep;

use super::super::events::{ItemOperation, PulledItem, SyncEvent};
use super::super::result::SyncNowBlockedReason;
use super::super::status::SyncStatusValue;
use super::rig::{Rig, lock, settle};

fn record(item_id: &str, outcome: AppliedOutcome) -> AppliedRecord {
    typed("task", item_id, outcome)
}

fn typed(item_type: &str, item_id: &str, outcome: AppliedOutcome) -> AppliedRecord {
    AppliedRecord {
        item_type: item_type.into(),
        item_id: item_id.into(),
        outcome,
        conflicts: Vec::new(),
    }
}

#[tokio::test(start_paused = true)]
async fn the_drivers_feed_tells_synced_corrupt_recovered_and_quarantined_records() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    // A second pass on the same driver registers nothing again.
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    let observers = lock(&rig.backend.driver.observers).clone();
    assert_eq!(observers.len(), 1, "one observer for the driver's life");

    observers[0].records_applied(&[
        record("t1", AppliedOutcome::Created),
        record("t2", AppliedOutcome::Skipped),
        record("t3", AppliedOutcome::Merged),
        record("t4", AppliedOutcome::Deleted),
    ]);
    let warning = SecurityWarning {
        item_type: "note".into(),
        item_id: "n1".into(),
        signer_device_id: "d1".into(),
        attempt_count: 2,
        permanent: false,
    };
    observers[0].security_warning(&warning);
    observers[0].item_corrupt(&CorruptItem {
        item_type: "note".into(),
        item_id: "n1".into(),
        reason: "a truncated blob".into(),
        warning: Some(warning.clone()),
    });
    observers[0].item_recovered(&record("t5", AppliedOutcome::Updated));

    let pulled = |id: &str, operation| PulledItem {
        item_type: "task".into(),
        item_id: id.into(),
        operation,
    };
    assert_eq!(
        *lock(&rig.sync_events),
        [
            SyncEvent::Pulled(vec![
                pulled("t1", ItemOperation::Create),
                pulled("t3", ItemOperation::Update),
                pulled("t4", ItemOperation::Delete),
            ]),
            SyncEvent::SecurityWarning(warning),
            SyncEvent::Corrupt {
                item_type: "note".into(),
                item_id: "n1".into(),
                reason: "a truncated blob".into(),
            },
            SyncEvent::Recovered {
                item_type: "task".into(),
                item_id: "t5".into(),
            },
        ]
    );
}

/// One page is one event, whatever its size: K records reach the renderer as one broadcast.
/// A record applied twice in one page is told once, with its last operation. Notes and
/// journals are the vault tier's to tell (`shell/note_events.rs`, `journal_events.rs`).
#[tokio::test(start_paused = true)]
async fn a_page_is_told_once_deduped_last_operation_wins_without_documents() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    let observers = lock(&rig.backend.driver.observers).clone();

    observers[0].records_applied(&[
        record("t1", AppliedOutcome::Created),
        typed("project", "p1", AppliedOutcome::Updated),
        typed("note", "n1", AppliedOutcome::Updated),
        typed("journal", "j1", AppliedOutcome::Created),
        record("t1", AppliedOutcome::Deleted),
        typed("task", "p1", AppliedOutcome::Created),
        record("t2", AppliedOutcome::Skipped),
    ]);

    let item = |item_type: &str, id: &str, operation| PulledItem {
        item_type: item_type.into(),
        item_id: id.into(),
        operation,
    };
    assert_eq!(
        *lock(&rig.sync_events),
        [SyncEvent::Pulled(vec![
            item("task", "t1", ItemOperation::Delete),
            item("project", "p1", ItemOperation::Update),
            item("task", "p1", ItemOperation::Create),
        ])]
    );
}

/// A page that changed nothing the renderer shows tells nothing.
#[tokio::test(start_paused = true)]
async fn a_page_of_skipped_or_document_records_tells_nothing() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    let observers = lock(&rig.backend.driver.observers).clone();

    observers[0].records_applied(&[
        record("t1", AppliedOutcome::Skipped),
        record("t2", AppliedOutcome::Skipped),
    ]);
    observers[0].records_applied(&[typed("note", "n1", AppliedOutcome::Created)]);
    observers[0].records_applied(&[]);

    let told = lock(&rig.sync_events).clone();
    assert!(told.is_empty(), "{told:?}");
}

#[tokio::test(start_paused = true)]
async fn a_push_that_empties_the_queue_tells_queue_cleared() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    assert!(lock(&rig.sync_events).is_empty(), "nothing pushed");

    rig.backend.driver.pushed_items.store(3, Ordering::SeqCst);
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert!(
        matches!(
            lock(&rig.sync_events).as_slice(),
            // The push's own time (`push-coordinator.ts:531`), not the whole pass's.
            [SyncEvent::QueueCleared {
                item_count: 3,
                duration_ms: 7
            }]
        ),
        "{:?}",
        lock(&rig.sync_events)
    );

    // Rows still queued after the push: the queue is not clear.
    lock(&rig.sync_events).clear();
    rig.db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at) \
                 VALUES ('task', 't9', 'update', 0)",
                [],
            )
            .map(drop)
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .unwrap();
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert!(lock(&rig.sync_events).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_clock_skew_pause_tells_the_skew_in_seconds() {
    let rig = Rig::new();
    *lock(&rig.backend.driver.skew_ms) = Some(-400_000);
    let supervisor = rig.start().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Paused);
    let events = lock(&rig.sync_events).clone();
    assert!(
        matches!(
            events.as_slice(),
            [SyncEvent::ClockSkew { local_s, server_s, skew_s: 400 }] if server_s - local_s == 400
        ),
        "{events:?}"
    );
}

/// `engine.ts:663-668`: pausing cuts the run in flight, so nothing it would still push goes out
/// after the user paused, and a Sync Now waiting on it hears `paused`. The cut is the driver's
/// (its requests answer `Cancelled`), never an abort of the task: a pass dropped at an await
/// loses whatever it held in memory there (REVIEW-4892 items 1, 2, 5).
#[tokio::test(start_paused = true)]
async fn a_pause_cuts_the_pass_in_flight_and_answers_its_waiters_paused() {
    let rig = Rig::new();
    let hold = Arc::new(tokio::sync::Notify::new());
    *lock(&rig.backend.driver.hold) = Some(Arc::clone(&hold));
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1, "the start pass is in flight");

    let waiting = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.sync_now().await }
    });
    sleep(Duration::from_millis(1)).await;
    supervisor.set_paused(true).await.unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(60), waiting)
        .await
        .expect("the pause answers the waiter")
        .unwrap();
    assert_eq!(answer.reason, Some(SyncNowBlockedReason::Paused));

    settle().await;
    assert_eq!(
        rig.backend.driver.finished.load(Ordering::SeqCst),
        1,
        "the cut pass ran to its end"
    );
    assert_eq!(rig.passes(), 1, "no trailing pass");
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Paused);
    assert_eq!(status.error, None, "a cut is not a failure");
    let skew = lock(&rig.sync_events).clone();
    assert!(skew.is_empty(), "{skew:?}");
}

/// Electron's `setPaused` pauses in memory even when the write fails, so the clock-skew event
/// and the status agree (REVIEW-4892 item 4).
#[tokio::test(start_paused = true)]
async fn a_clock_skew_pause_holds_when_its_write_fails() {
    let rig = Rig::new();
    rig.db
        .call_blocking(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER no_insert BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'full'); END;
                 CREATE TRIGGER no_update BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'full'); END;",
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .unwrap();
    *lock(&rig.backend.driver.skew_ms) = Some(-400_000);
    let supervisor = rig.start().await;

    assert!(matches!(
        lock(&rig.sync_events).as_slice(),
        [SyncEvent::ClockSkew { .. }]
    ));
    assert_eq!(supervisor.status().status, SyncStatusValue::Paused);
    assert!(rig.backend.driver.paused.load(Ordering::SeqCst));
}
