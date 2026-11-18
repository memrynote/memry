//! The sync events besides the status, and what a pause does to the pass in flight.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError, TransportError};
use memry_core::sync::driver::progress::{InitialSyncPhase, InitialSyncProgress};
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

fn progress(phase: InitialSyncPhase, processed_items: u64, total_items: u64) -> SyncEvent {
    SyncEvent::InitialSyncProgress(InitialSyncProgress {
        phase,
        processed_items,
        total_items,
    })
}

/// A vault with no finished first sync runs the driver's first sync, not a pass, and tells its
/// progress (#4893); the passes after it are ordinary ones.
#[tokio::test(start_paused = true)]
async fn a_fresh_vault_runs_the_first_sync_with_its_progress_then_passes() {
    let rig = Rig::new();
    rig.backend.driver.fresh.store(true, Ordering::SeqCst);
    let supervisor = rig.start().await;
    let driver = &rig.backend.driver;
    assert_eq!(driver.first_syncs.load(Ordering::SeqCst), 1);
    assert_eq!(
        *lock(&rig.sync_events),
        [
            progress(InitialSyncPhase::Notes, 1, 2),
            progress(InitialSyncPhase::Complete, 0, 0),
        ]
    );
    assert!(supervisor.status().last_sync_at.is_some());

    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert_eq!(driver.first_syncs.load(Ordering::SeqCst), 1);
    assert_eq!(rig.passes(), 2, "the first sync's pass, then Sync Now's");
    assert_eq!(
        lock(&rig.sync_events).len(),
        2,
        "an ordinary pass tells no progress"
    );
}

/// A first sync that fails is shown and backed off like a failed pass; the next pass runs the
/// first sync again, which resumes from what it wrote.
#[tokio::test(start_paused = true)]
async fn a_failed_first_sync_is_shown_and_the_next_pass_runs_it_again() {
    let rig = Rig::new();
    let driver = &rig.backend.driver;
    driver.fresh.store(true, Ordering::SeqCst);
    *lock(&driver.first_sync_error) = Some(SyncError::Api {
        source: ApiError::Status {
            status: 503,
            code: None,
            message: "unavailable".into(),
        },
    });
    let supervisor = rig.start().await;
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Error, "{status:?}");
    assert_eq!(rig.passes(), 0, "no pass ran past the failed first sync");
    assert!(status.last_sync_at.is_none());

    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert_eq!(driver.first_syncs.load(Ordering::SeqCst), 2);
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);
}

/// A pause that cuts the first sync records no failure: the status shows no error.
#[tokio::test(start_paused = true)]
async fn a_first_sync_the_pause_cut_records_no_failure() {
    let rig = Rig::new();
    let driver = &rig.backend.driver;
    driver.fresh.store(true, Ordering::SeqCst);
    *lock(&driver.first_sync_error) = Some(SyncError::from(ApiError::Transport {
        source: TransportError::Cancelled,
    }));
    let supervisor = rig.start().await;
    let status = supervisor.status();
    assert_eq!(status.error, None, "{status:?}");
    assert_ne!(status.status, SyncStatusValue::Error);
}
