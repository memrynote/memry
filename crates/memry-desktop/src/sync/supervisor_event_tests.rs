//! The sync events besides the status, and what a pause does to the pass in flight.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError, TransportError};
use memry_core::sync::driver::progress::{InitialSyncPhase, InitialSyncProgress};
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
        title_before: None,
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

/// The core's task-activity announcement, told after its rows committed, reaches the shell.
#[tokio::test(start_paused = true)]
async fn the_drivers_task_activity_announcement_reaches_the_shell() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    let observers = lock(&rig.backend.driver.observers).clone();

    observers[0].task_activity_created(&["t1".to_owned(), "t2".to_owned()]);

    assert_eq!(
        *lock(&rig.sync_events),
        [SyncEvent::TaskActivityCreated(vec![
            "t1".into(),
            "t2".into()
        ])]
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

/// The first sync holds the vault's first-sync flag while it runs, and lets go when it ends,
/// a failed one too: the note index defers its search reindex only meanwhile (#5409).
#[tokio::test(start_paused = true)]
async fn a_first_sync_holds_the_first_sync_flag_only_while_it_runs() {
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
    assert_eq!(*lock(&driver.held_in_first_sync), [true]);
    assert!(
        !driver.first_sync_running.is_running(),
        "a failed first sync lets go"
    );

    let (_, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert_eq!(*lock(&driver.held_in_first_sync), [true, true]);
    assert!(
        !driver.fresh.load(Ordering::SeqCst),
        "the second first sync finished"
    );
    assert!(
        !driver.first_sync_running.is_running(),
        "a finished first sync lets go"
    );
}

/// A pass whose body step stopped at its request budget is followed by the next pass at once,
/// not at the 60 s tick, until a pass leaves no body due (#5235).
#[tokio::test(start_paused = true)]
async fn passes_keep_coming_while_the_body_budget_leaves_bodies_due() {
    let rig = Rig::new();
    rig.backend.driver.bodies_left.store(2, Ordering::SeqCst);
    let _supervisor = rig.start().await;
    settle().await;
    settle().await;
    assert_eq!(
        rig.passes(),
        3,
        "the start's pass, then one per budget it spent"
    );
    settle().await;
    assert_eq!(
        rig.passes(),
        3,
        "a pass that left nothing due waits for its timer"
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
    assert_eq!(
        rig.passes(),
        1,
        "a pass drained the outbox after the failed first sync"
    );
    assert!(status.last_sync_at.is_none());

    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert_eq!(driver.first_syncs.load(Ordering::SeqCst), 2);
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);
}

/// A first sync that keeps failing (one body the server keeps refusing) does not hold the
/// outbox back: a pass after each failure pushes, as Electron's full sync seeds and pushes on
/// every run while the device is fresh (`full-sync-runner.ts:400-455`). The vault stays fresh,
/// the failure stays shown, and its backoff still doubles.
#[tokio::test(start_paused = true)]
async fn a_first_sync_that_keeps_failing_still_pushes_and_stays_fresh() {
    let rig = Rig::new();
    let driver = &rig.backend.driver;
    driver.fresh.store(true, Ordering::SeqCst);
    driver.pushed_items.store(2, Ordering::SeqCst);
    driver
        .first_sync_keeps_failing
        .store(true, Ordering::SeqCst);
    *lock(&driver.first_sync_error) = Some(SyncError::Api {
        source: ApiError::Status {
            status: 502,
            code: None,
            message: "bad gateway".into(),
        },
    });
    let supervisor = rig.start().await;
    sleep(Duration::from_secs(40 * 60)).await;
    let first_syncs = driver.first_syncs.load(Ordering::SeqCst);
    assert!(rig.passes() >= 1, "no push in 40 minutes");
    assert_eq!(
        rig.passes(),
        first_syncs,
        "one draining pass per failed first sync"
    );
    // 5 s doubling to 5 min, not a retry every 5 s.
    assert!(first_syncs <= 16, "{first_syncs} first syncs in 40 minutes");
    assert!(driver.fresh.load(Ordering::SeqCst));
    assert_eq!(supervisor.status().status, SyncStatusValue::Error);
    let cleared = lock(&rig.sync_events)
        .iter()
        .filter(|event| matches!(event, SyncEvent::QueueCleared { item_count: 2, .. }))
        .count();
    assert!(cleared >= 1, "the draining pass tells queue-cleared");
}

/// An offline first sync answers offline and does not back off, as an offline pass does; no
/// pass runs after it, which would fail the same way.
#[tokio::test(start_paused = true)]
async fn an_offline_first_sync_answers_offline_without_a_backoff() {
    let rig = Rig::new();
    let driver = &rig.backend.driver;
    driver.fresh.store(true, Ordering::SeqCst);
    *lock(&driver.first_sync_error) = Some(SyncError::from(ApiError::Transport {
        source: TransportError::Offline,
    }));
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 0);
    // An automatic trigger waits out a backoff; with none it runs at once.
    supervisor.request_push();
    settle().await;
    assert_eq!(driver.first_syncs.load(Ordering::SeqCst), 2);
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

/// The first sync's answer carries every catch-up pass's pushed rows and push time, so
/// queue-cleared counts what the whole first sync sent; the rest is the last pass's.
#[test]
fn a_first_sync_answers_its_last_pass_with_every_push() {
    use memry_core::sync::engine::PassReport;
    use memry_core::sync::pull::PullReport;
    use memry_core::sync::state::{PassTrigger, SyncState};

    let pass = |pushed_items: usize, push_ms: u64, final_state| PassReport {
        trigger: PassTrigger::Explicit,
        transitions: vec![SyncState::Pulling, final_state],
        final_state,
        pull: PullReport::default(),
        parked: false,
        pushed: pushed_items > 0,
        pushed_items,
        push_ms,
        pull_error: None,
        push_error: None,
        bodies_left: false,
    };
    let folded = super::super::backend::last_with_every_push(vec![
        pass(3, 20, SyncState::Applying),
        pass(2, 5, SyncState::Applying),
        pass(0, 0, SyncState::Idle),
    ])
    .expect("passes ran");
    assert_eq!(folded.pushed_items, 5);
    assert_eq!(folded.push_ms, 25);
    assert!(folded.pushed);
    assert_eq!(folded.final_state, SyncState::Idle, "the last pass's state");
    assert!(super::super::backend::last_with_every_push(Vec::new()).is_none());
}
