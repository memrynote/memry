//! The supervisor's latches, backoff, keychain ladder and hints, on a paused tokio clock over the
//! fakes of [`super::rig`].

use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError, TransportError};
use memry_core::sync::socket::{Terminal, parse_frame};
use memry_core::sync::state::PassTrigger;
use tokio::sync::broadcast::error::TryRecvError;
use tokio::time::{Instant, sleep};

use super::super::error_category::SyncErrorCategory;
use super::super::gate::{Entitlement, VaultBinding};
use super::super::realtime::SocketEnd;
use super::super::result::SyncNowBlockedReason;
use super::super::signals::{AuthSignal, SessionEndReason};
use super::super::status::SyncStatusValue;
use super::SyncSupervisor;
use super::rig::{Rig, lock, settle};

fn unauthorized() -> SyncError {
    SyncError::Api {
        source: ApiError::Unauthorized {
            code: "AUTH_INVALID_TOKEN".into(),
            message: "expired".into(),
        },
    }
}

/// Every automatic and explicit trigger, ten minutes of ticks and a Sync Now: what a latched loop
/// must not run a pass for.
async fn poke(supervisor: &SyncSupervisor) -> super::super::result::TriggerSyncResult {
    supervisor.request_push();
    supervisor.foreground();
    sleep(Duration::from_secs(600)).await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    result
}

/// A start that waits on the binding, so a test subscribes before the first pass.
async fn start_unbound(rig: &Rig) -> SyncSupervisor {
    rig.gate.set_binding(VaultBinding::Unknown);
    rig.start().await
}

#[tokio::test(start_paused = true)]
async fn a_refused_refresh_sends_one_session_expired_and_stops_sync() {
    let rig = Rig::new();
    rig.backend.refresh_refused.store(true, Ordering::SeqCst);
    lock(&rig.backend.driver.errors).push(unauthorized());
    let supervisor = start_unbound(&rig).await;
    let mut signals = supervisor.subscribe_auth_signals();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    assert_eq!(rig.passes(), 1);

    let after = poke(&supervisor).await;
    assert_eq!(rig.passes(), 1, "no pass after the latch");
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Failed));
    assert!(after.error.is_some(), "Sync Now says why: {after:?}");
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Error);
    assert_eq!(status.error_category, Some(SyncErrorCategory::AuthExpired));
    assert_eq!(
        signals.try_recv(),
        Ok(AuthSignal::SessionExpired {
            reason: SessionEndReason::RefreshRejected
        })
    );
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty), "sent once");
}

/// A 401 the token manager may still refresh past backs off; it does not end sync.
#[tokio::test(start_paused = true)]
async fn a_401_with_a_live_refresh_token_backs_off_and_retries() {
    let rig = Rig::new();
    lock(&rig.backend.driver.errors).push(unauthorized());
    let supervisor = start_unbound(&rig).await;
    let mut signals = supervisor.subscribe_auth_signals();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    sleep(Duration::from_secs(5)).await;
    settle().await;
    assert_eq!(rig.passes(), 2, "the backoff's end ran a pass");
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty));
}

/// A close 4004 ends sync and says so once; a later `AUTH_DEVICE_REVOKED` frame says nothing new.
#[tokio::test(start_paused = true)]
async fn a_revoked_socket_sends_one_device_revoked_and_stops_sync() {
    let rig = Rig::new();
    *lock(&rig.backend.driver.socket_end) = Some(SocketEnd::Terminal(Terminal::DeviceRevoked));
    let supervisor = start_unbound(&rig).await;
    let mut signals = supervisor.subscribe_auth_signals();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    assert_eq!(rig.passes(), 1);
    assert_eq!(rig.backend.driver.sockets.load(Ordering::SeqCst), 1);
    assert_eq!(signals.try_recv(), Ok(AuthSignal::DeviceRevoked));

    let after = poke(&supervisor).await;
    assert_eq!(rig.passes(), 1, "no pass after the latch");
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(
        rig.backend.driver.sockets.load(Ordering::SeqCst),
        1,
        "no socket after a terminal close"
    );
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::DeviceRevoked)
    );
    supervisor
        .hint_sink()
        .hint(parse_frame(REVOKED_FRAME).unwrap());
    settle().await;
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty), "sent once");
}

const REVOKED_FRAME: &[u8] = br#"{"type":"error","payload":{"code":"AUTH_DEVICE_REVOKED"}}"#;

/// The `engine.ts` `error` arm: the frame alone ends sync.
#[tokio::test(start_paused = true)]
async fn a_revoked_frame_sends_device_revoked_and_stops_sync() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let mut signals = supervisor.subscribe_auth_signals();
    supervisor
        .hint_sink()
        .hint(parse_frame(REVOKED_FRAME).unwrap());
    let after = poke(&supervisor).await;
    assert_eq!(rig.passes(), 1, "no pass after the latch");
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(signals.try_recv(), Ok(AuthSignal::DeviceRevoked));
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty));
}

/// A pin mismatch on a pass ends sync for the loop's life, with no account signal.
#[tokio::test(start_paused = true)]
async fn a_pin_failure_latches_sync_off_without_an_account_signal() {
    let rig = Rig::new();
    lock(&rig.backend.driver.errors).push(SyncError::Api {
        source: ApiError::Transport {
            source: TransportError::Tls {
                what: "pin mismatch".into(),
            },
        },
    });
    let supervisor = start_unbound(&rig).await;
    let mut signals = supervisor.subscribe_auth_signals();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    let after = poke(&supervisor).await;
    assert_eq!(rig.passes(), 1, "no pass after the latch");
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::CertificatePinFailed)
    );
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test(start_paused = true)]
async fn ten_hints_during_a_pass_queue_exactly_one_trailing_pass() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let before = rig.passes();
    supervisor.foreground();
    tokio::task::yield_now().await;
    let sink = supervisor.hint_sink();
    for cursor in 1..=10 {
        let frame = format!(r#"{{"type":"changes_available","payload":{{"cursor":{cursor}}}}}"#);
        sink.hint(parse_frame(frame.as_bytes()).unwrap());
    }
    for _ in 0..4 {
        settle().await;
    }
    assert_eq!(
        rig.passes(),
        before + 2,
        "the running pass and one trailing"
    );
    assert_eq!(
        lock(&rig.backend.driver.passes).last(),
        Some(&PassTrigger::SocketHint)
    );
}

fn gaps_in_secs(times: &[Instant]) -> Vec<u64> {
    times
        .windows(2)
        .map(|pair| ((pair[1] - pair[0]).as_millis() as u64 + 500) / 1000)
        .collect()
}

/// REVIEW-4713 Low 12: an open that keeps failing is retried 5 s doubling to 5 min, and edits in
/// the meantime do not run passes of their own.
#[tokio::test(start_paused = true)]
async fn a_failing_open_backs_off_from_5_s_doubling_to_5_min() {
    let rig = Rig::new();
    rig.backend.fail_open.store(true, Ordering::SeqCst);
    let supervisor = rig.start().await;
    for _ in 0..50 {
        supervisor.request_push();
        sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        rig.backend.opens(),
        2,
        "10 s of edits: the start and one retry at 5 s"
    );

    sleep(Duration::from_secs(20 * 60)).await;
    let gaps = gaps_in_secs(&lock(&rig.backend.opens));
    assert_eq!(gaps[..8], [5, 10, 20, 40, 80, 160, 300, 300], "{gaps:?}");
    assert_eq!(supervisor.status().status, SyncStatusValue::Error);

    // Sync Now does not wait the backoff out.
    let opens = rig.backend.opens();
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert_eq!(result.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(rig.backend.opens(), opens + 1);
}

/// `keychain-retry.ts`: an unreadable keychain retries at 15, 30, 60, 120 then every 300 s, and
/// at once when the keychain says it answers again.
#[tokio::test(start_paused = true)]
async fn a_locked_keychain_retries_along_the_ladder_and_at_once_on_recovery() {
    let rig = Rig::new();
    rig.backend.keychain_locked.store(true, Ordering::SeqCst);
    let supervisor = rig.start().await;
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Error);
    assert_eq!(
        status.error_category,
        Some(SyncErrorCategory::KeychainUnavailable)
    );

    sleep(Duration::from_secs(15 * 60)).await;
    let reads = lock(&rig.backend.fact_reads).clone();
    let start = reads[0];
    let at: Vec<u64> = reads[1..]
        .iter()
        .map(|read| gaps_in_secs(&[start, *read])[0])
        .collect();
    assert_eq!(at, [15, 45, 105, 225, 525, 825], "retries at");
    assert_eq!(rig.backend.opens(), 0, "nothing opened while locked");
    assert_eq!(rig.closes(), 0, "a loop that never opened closes nothing");

    rig.backend.keychain_locked.store(false, Ordering::SeqCst);
    rig.recovered.send(()).unwrap();
    sleep(Duration::from_secs(1)).await;
    assert_eq!(rig.passes(), 1, "a pass within 1 s of the recovery");
    settle().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);
}

/// VERIFY-4713 Low 5: a loop the gate held from its start never installed the key, so its stop
/// leaves the key alone.
#[tokio::test(start_paused = true)]
async fn a_loop_gated_from_its_start_never_closes() {
    let rig = Rig::new();
    let supervisor = start_unbound(&rig).await;
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    supervisor.stop().await;
    assert_eq!(rig.backend.opens(), 0);
    assert_eq!(rig.closes(), 0);
}

/// VERIFY-4713 Low 8: a pass that panicked answers Sync Now as a failure, with a reason.
#[tokio::test(start_paused = true)]
async fn a_panicked_pass_answers_sync_now_as_a_failure() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    rig.backend.driver.panic_next.store(true, Ordering::SeqCst);
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert_eq!(result.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(result.error.as_deref(), Some("Sync failed unexpectedly"));
    assert_eq!(supervisor.status().status, SyncStatusValue::Error);
}

/// VERIFY-4713 Low 7: a loop stuck in a keychain prompt does not hold a session close.
#[tokio::test(flavor = "multi_thread")]
async fn a_blocking_stop_gives_up_on_a_loop_stuck_in_the_keychain() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    rig.backend.stall_facts.store(true, Ordering::SeqCst);
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    let stopped = tokio::task::spawn_blocking(move || {
        supervisor.stop_blocking_within(Duration::from_millis(50))
    })
    .await
    .unwrap();
    assert!(!stopped, "the close went on without the loop");
}

/// The Readwise pull gate's readings (`isSyncDecided`, `isCaughtUpWithServer`): a vault list not
/// fetched yet is no verdict, signed out is one, and only a clean pass catches up.
#[tokio::test(start_paused = true)]
async fn the_verdict_waits_for_the_vault_list_and_only_a_clean_pass_catches_up() {
    let rig = Rig::new();
    let supervisor = start_unbound(&rig).await;
    settle().await;
    assert!(!supervisor.decided(), "an unknown binding is no verdict");
    assert!(!supervisor.caught_up());
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    assert!(supervisor.decided() && supervisor.status().sync_eligible);
    assert!(supervisor.caught_up(), "a clean pass caught up");

    lock(&rig.backend.driver.errors).push(unauthorized());
    supervisor.request_push();
    sleep(Duration::from_secs(1)).await;
    settle().await;
    assert!(!supervisor.caught_up(), "a failed pass did not");

    let signed_out = Rig::new();
    signed_out.backend.signed_in.store(false, Ordering::SeqCst);
    let supervisor = signed_out.start().await;
    settle().await;
    assert!(
        supervisor.decided(),
        "signed out is a verdict: this install does not sync"
    );
    assert!(!supervisor.status().sync_eligible);
}
