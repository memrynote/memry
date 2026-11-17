//! The sync events besides the status, and what a pause does to the pass in flight.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, CorruptItem, SecurityWarning};
use tokio::time::sleep;

use super::super::events::{ItemOperation, SyncEvent};
use super::super::result::SyncNowBlockedReason;
use super::super::status::SyncStatusValue;
use super::rig::{Rig, lock, settle};

fn record(item_id: &str, outcome: AppliedOutcome) -> AppliedRecord {
    AppliedRecord {
        item_type: "task".into(),
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

    let pulled = |id: &str, operation| SyncEvent::Pulled {
        item_type: "task".into(),
        item_id: id.into(),
        operation,
    };
    assert_eq!(
        *lock(&rig.sync_events),
        [
            pulled("t1", ItemOperation::Create),
            pulled("t3", ItemOperation::Update),
            pulled("t4", ItemOperation::Delete),
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
            [SyncEvent::QueueCleared { item_count: 3, duration_ms }] if *duration_ms >= 50
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

/// `engine.ts:663-668`: pausing aborts the run in flight, so nothing it would still push goes
/// out after the user paused, and a Sync Now waiting on it hears `paused`.
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
    // Without the cut the held pass never ends, so its waiter would hang.
    let answer = tokio::time::timeout(Duration::from_secs(60), waiting)
        .await
        .expect("the pause answers the waiter")
        .unwrap();
    assert_eq!(answer.reason, Some(SyncNowBlockedReason::Paused));

    hold.notify_waiters();
    settle().await;
    assert_eq!(
        rig.backend.driver.finished.load(Ordering::SeqCst),
        0,
        "the cut pass pushed nothing after the pause"
    );
    assert_eq!(rig.passes(), 1, "no trailing pass");
    assert_eq!(supervisor.status().status, SyncStatusValue::Paused);
}
