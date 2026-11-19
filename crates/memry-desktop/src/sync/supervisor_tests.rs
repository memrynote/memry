//! The supervisor on a paused tokio clock, over the fakes of [`super::rig`].

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError};
use memry_core::seams::reachability::Reachable;
use memry_core::sync::pause;
use tokio::time::sleep;

use super::super::gate::{Entitlement, VaultBinding};
use super::super::result::SyncNowBlockedReason;
use super::super::status::SyncStatusValue;
use super::rig::{PASS, Rig, lock, settle};

#[tokio::test(start_paused = true)]
async fn the_gate_decides_whether_a_pass_runs_and_a_change_starts_one() {
    let rig = Rig::new();
    rig.gate.set_binding(VaultBinding::Unknown);
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 0, "an unknown binding waits");
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);

    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    assert_eq!(rig.passes(), 1, "binding the vault starts sync");
    assert_eq!(rig.backend.opens(), 1);
    assert_eq!(*lock(&rig.backend.driver.entitled), Some(true));

    let closes = rig.backend.closes.load(Ordering::SeqCst);
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    assert_eq!(
        rig.backend.closes.load(Ordering::SeqCst),
        closes + 1,
        "the driver is closed"
    );
    assert_eq!(supervisor.status().status, SyncStatusValue::LocalOnly);
}

/// A `402` demotes the driver's policy tier while the gate still says `Entitled`; billing's next
/// paid answer repeats `Entitled`, and that has to reach the driver (§11.7.1), with no new pass.
#[tokio::test(start_paused = true)]
async fn a_repeated_paid_verdict_reaches_a_driver_a_402_demoted() {
    let rig = Rig::new();
    let _supervisor = rig.start().await;
    let passes = rig.passes();
    *lock(&rig.backend.driver.entitled) = Some(false);

    rig.gate.set_entitlement(Entitlement::Entitled);
    settle().await;

    assert_eq!(*lock(&rig.backend.driver.entitled), Some(true));
    assert_eq!(
        rig.passes(),
        passes,
        "the gate did not change, so no start pass"
    );
}

/// Leading edge with a trailing guard (`push-coordinator.ts:585-609`, #2289): a push after a
/// quiet window goes out at once, and steady writes push once per 300 ms instead of never.
#[tokio::test(start_paused = true)]
async fn a_push_goes_out_at_once_and_steady_writes_push_once_per_window() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1, "the start pass");

    sleep(Duration::from_secs(1)).await;
    supervisor.request_push();
    sleep(Duration::from_millis(1)).await;
    assert_eq!(
        rig.passes(),
        2,
        "a push after a quiet window goes out at once"
    );

    settle().await;
    let before = rig.passes();
    for _ in 0..50 {
        supervisor.request_push();
        sleep(Duration::from_millis(200)).await;
    }
    let pushed = rig.passes() - before;
    assert!(
        pushed >= 20,
        "10 s of writes 200 ms apart pushed {pushed} times"
    );
    let starts = lock(&rig.backend.driver.starts).clone();
    for pair in starts[1..].windows(2) {
        assert!(
            pair[1] - pair[0] >= Duration::from_millis(300),
            "two pushes {:?} apart",
            pair[1] - pair[0]
        );
    }

    // The pass is running: two requests queue exactly one trailing pass.
    settle().await;
    let before = rig.passes();
    supervisor.foreground();
    tokio::task::yield_now().await;
    supervisor.foreground();
    supervisor.foreground();
    settle().await;
    settle().await;
    assert_eq!(rig.passes(), before + 2);
}

#[tokio::test(start_paused = true)]
async fn a_tick_pulls_only_when_the_socket_did_not_stay_connected() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1);

    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 2, "no socket: every tick pulls");

    supervisor.note_socket(1, true);
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(
        rig.passes(),
        3,
        "the socket connected during this tick's window"
    );
    for _ in 0..4 {
        sleep(Duration::from_secs(60)).await;
        settle().await;
    }
    assert_eq!(rig.passes(), 3, "a held socket keeps the ticks quiet");
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 4, "five minutes since the last pull");

    supervisor.note_socket(1, false);
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 5, "the socket dropped");
}

#[tokio::test(start_paused = true)]
async fn a_429_backs_off_and_sync_now_says_when_it_resumes() {
    let rig = Rig::new();
    lock(&rig.backend.driver.errors).push(SyncError::Api {
        source: ApiError::RateLimited {
            retry_after_s: None,
            message: "slow down".into(),
        },
    });
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1);
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Error);
    assert_eq!(
        status.error_category,
        Some(super::super::error_category::SyncErrorCategory::RateLimited)
    );

    let refused = supervisor.sync_now().await;
    assert_eq!(refused.reason, Some(SyncNowBlockedReason::Failed));
    assert!(
        refused
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("Rate limited. Resuming in ")),
        "{refused:?}"
    );
    supervisor.request_push();
    settle().await;
    assert_eq!(rig.passes(), 1, "inside the 5 s window nothing runs");

    // `error-recovery-handler.ts:162-169`: the window's end runs a pass by itself, which
    // pushes what the window held back.
    sleep(Duration::from_secs(5)).await;
    settle().await;
    assert_eq!(rig.passes(), 2, "the window's end runs a pass");
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);

    let ran = supervisor.sync_now();
    let (ran, ()) = tokio::join!(ran, settle());
    assert!(ran.success, "{ran:?}");
    assert_eq!(rig.passes(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_pause_is_persisted_survives_a_reopen_and_sync_now_ends_it() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.set_paused(true).await.unwrap();
    assert!(rig.db.read_blocking(pause::read).unwrap());
    supervisor.stop().await;

    let reopened = rig.start().await;
    let passes = rig.passes();
    reopened.request_push();
    sleep(Duration::from_secs(61)).await;
    settle().await;
    assert_eq!(rig.passes(), passes, "paused across the reopen");
    assert_eq!(reopened.status().status, SyncStatusValue::Paused);

    let (result, ()) = tokio::join!(reopened.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert!(!rig.db.read_blocking(pause::read).unwrap());
    assert_eq!(rig.passes(), passes + 1);
}

#[tokio::test(start_paused = true)]
async fn clock_skew_past_five_minutes_pauses_sync_and_persists_it() {
    let rig = Rig::new();
    *lock(&rig.backend.driver.skew_ms) = Some(300_001);
    let supervisor = rig.start().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Paused);
    assert!(rig.db.read_blocking(pause::read).unwrap());
    assert!(rig.backend.driver.paused.load(Ordering::SeqCst));

    // The user fixed the clock. No status poll ran since (the driver keeps the old reading),
    // and Sync Now does not pause again on it.
    *lock(&rig.backend.driver.skew_ms) = None;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);
    assert!(!rig.db.read_blocking(pause::read).unwrap());

    let rig = Rig::new();
    *lock(&rig.backend.driver.skew_ms) = Some(-300_000);
    let supervisor = rig.start().await;
    assert_eq!(
        supervisor.status().status,
        SyncStatusValue::Idle,
        "exactly 300 s is fine"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_now_names_why_it_did_nothing() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    rig.net.set(Reachable::Offline);
    settle().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Offline);
    let offline = supervisor.sync_now().await;
    assert_eq!(offline.reason, Some(SyncNowBlockedReason::Offline));

    rig.net.set(Reachable::Wifi);
    settle().await;
    rig.gate.set_binding(VaultBinding::Foreign);
    settle().await;
    let gated = supervisor.sync_now().await;
    assert_eq!(gated.reason, Some(SyncNowBlockedReason::Unavailable));

    rig.backend.signed_in.store(false, Ordering::SeqCst);
    let signed_out = supervisor.sync_now().await;
    assert_eq!(signed_out.reason, Some(SyncNowBlockedReason::SignedOut));
}

#[tokio::test(start_paused = true)]
async fn status_events_are_throttled_to_one_per_100_ms_and_the_latest_wins() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    for _ in 0..5 {
        rig.net.set(Reachable::Offline);
        tokio::task::yield_now().await;
        rig.net.set(Reachable::Wifi);
        tokio::task::yield_now().await;
    }
    settle().await;
    settle().await;
    let events = lock(&rig.events).clone();
    for pair in events.windows(2) {
        assert!(
            pair[1].0 - pair[0].0 >= Duration::from_millis(100),
            "two events {:?} apart",
            pair[1].0 - pair[0].0
        );
    }
    assert_eq!(
        events.last().unwrap().1,
        supervisor.status(),
        "the latest status is emitted"
    );
}

/// A gate change during a pass answers the Sync Now waiting on it; nothing else ever would.
#[tokio::test(start_paused = true)]
async fn a_gate_change_answers_the_sync_now_waiting_on_the_pass_it_cut() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let close = async {
        sleep(PASS / 5).await;
        assert_eq!(rig.passes(), 2, "the Sync Now pass is running");
        rig.gate.set_entitlement(Entitlement::Unentitled);
    };
    let answered = tokio::time::timeout(Duration::from_secs(3600), async {
        tokio::join!(supervisor.sync_now(), close).0
    })
    .await
    .expect("Sync Now is answered");
    assert_eq!(answered.reason, Some(SyncNowBlockedReason::Unavailable));
}

/// Closing forgets the at-rest key even when no driver was kept: the open failed, or the pass
/// that opened it was cut.
#[tokio::test(start_paused = true)]
async fn closing_clears_the_key_when_the_open_failed_or_its_pass_was_cut() {
    let rig = Rig::new();
    rig.backend.fail_open.store(true, Ordering::SeqCst);
    let _supervisor = rig.start().await;
    assert_eq!(rig.backend.opens(), 1);
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    assert_eq!(rig.closes(), 1, "a failed open");

    let rig = Rig::new();
    rig.gate.set_binding(VaultBinding::Unknown);
    let _supervisor = rig.start().await;
    rig.gate.set_binding(VaultBinding::Bound);
    sleep(PASS / 5).await;
    assert_eq!(
        rig.passes(),
        1,
        "the first pass is running on a fresh driver"
    );
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    // Exactly one: the unbound start closed nothing it had not opened.
    assert_eq!(rig.closes(), 1, "a cut pass");
}

/// A `Refused` pass pushed nothing: it is a failure, never "synced just now".
#[tokio::test(start_paused = true)]
async fn a_refused_pass_is_a_failure() {
    let rig = Rig::new();
    rig.backend.driver.refuse.store(true, Ordering::SeqCst);
    let supervisor = rig.start().await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(!result.success, "{result:?}");
    assert_eq!(result.reason, Some(SyncNowBlockedReason::Failed));
    let status = supervisor.status();
    assert_eq!(status.last_sync_at, None);
    assert_eq!(status.status, SyncStatusValue::Error);
    assert_eq!(
        status.error_category,
        Some(super::super::error_category::SyncErrorCategory::ServerError)
    );
}

/// The last dropped handle ends the loop, though the reachability source keeps its observer.
#[tokio::test(start_paused = true)]
async fn dropping_every_handle_ends_the_loop() {
    let rig = Rig::new();
    let alone = Arc::strong_count(&rig.gate);
    let supervisor = rig.start().await;
    assert_eq!(
        Arc::strong_count(&rig.gate),
        alone + 1,
        "the loop holds the gate"
    );
    drop(supervisor);
    settle().await;
    assert_eq!(Arc::strong_count(&rig.gate), alone, "the loop ended");
}

#[tokio::test(start_paused = true)]
async fn stop_aborts_the_running_pass_and_closes_the_driver() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.foreground();
    tokio::task::yield_now().await;
    supervisor.stop().await;
    assert_eq!(rig.backend.closes.load(Ordering::SeqCst), 1);
    let after = supervisor.sync_now().await;
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Unavailable));
}
