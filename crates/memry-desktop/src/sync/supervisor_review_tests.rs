//! REVIEW-4728: a handshake 403, a refused refresh at open, the keychain ladder's gate, stops that
//! outlive a stuck loop, signals across rebuilds, and the latch's Lows, on the fakes of
//! [`super::rig`].

use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError};
use memry_core::sync::pause;
use memry_core::sync::socket::{Terminal, parse_frame};
use tokio::sync::broadcast::error::TryRecvError;
use tokio::time::sleep;

use super::super::error_category::SyncErrorCategory;
use super::super::gate::{Entitlement, VaultBinding};
use super::super::realtime::SocketEnd;
use super::super::result::SyncNowBlockedReason;
use super::super::signals::{AuthSignal, SessionEndReason};
use super::super::status::SyncStatusValue;
use super::rig::{Rig, lock, settle};

const REVOKED_FRAME: &[u8] = br#"{"type":"error","payload":{"code":"AUTH_DEVICE_REVOKED"}}"#;

fn unauthorized() -> SyncError {
    SyncError::Api {
        source: ApiError::Unauthorized {
            code: "AUTH_INVALID_TOKEN".into(),
            message: "expired".into(),
        },
    }
}

/// Medium 1: a WAF or an edge can refuse the handshake 403. The socket goes off and an explicit
/// pass asks the HTTP path, which alone says whether the device is revoked.
#[tokio::test(start_paused = true)]
async fn a_handshake_403_turns_the_socket_off_and_asks_the_http_path() {
    let rig = Rig::new();
    *lock(&rig.backend.driver.socket_end) = Some(SocketEnd::Terminal(Terminal::HandshakeForbidden));
    rig.gate.set_binding(VaultBinding::Unknown);
    let supervisor = rig.start().await;
    let mut signals = rig.signals.subscribe();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    settle().await;
    assert_eq!(
        rig.passes(),
        2,
        "the start and the explicit pass the 403 asked for"
    );
    assert_eq!(
        signals.try_recv(),
        Err(TryRecvError::Empty),
        "no account signal"
    );
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);

    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert!(result.success, "sync goes on over HTTP: {result:?}");
    assert_eq!(
        rig.backend.driver.sockets.load(Ordering::SeqCst),
        1,
        "the socket stays off"
    );
}

/// Medium 2: the refresh token was revoked while the app was closed. The open's device directory
/// fetch fails `AuthExpired`, and that latches once instead of backing off forever.
#[tokio::test(start_paused = true)]
async fn a_refused_refresh_at_open_latches_session_expired_once() {
    let rig = Rig::new();
    rig.backend.fail_open.store(true, Ordering::SeqCst);
    *lock(&rig.backend.open_error) = Some(unauthorized());
    rig.backend.refresh_refused.store(true, Ordering::SeqCst);
    rig.gate.set_binding(VaultBinding::Unknown);
    let supervisor = rig.start().await;
    let mut signals = rig.signals.subscribe();
    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    sleep(Duration::from_secs(600)).await;
    let (after, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert_eq!(rig.backend.opens(), 1, "no open after the latch");
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Failed));
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::AuthExpired)
    );
    assert_eq!(
        signals.try_recv(),
        Ok(AuthSignal::SessionExpired {
            reason: SessionEndReason::RefreshRejected
        })
    );
    assert_eq!(signals.try_recv(), Err(TryRecvError::Empty), "sent once");
}

/// Medium 3: a locked keychain only matters when the gate would start. Signed out, a vault that
/// does not sync, or an unpaid plan show the gate's own status and never walk the ladder.
#[tokio::test(start_paused = true)]
async fn a_locked_keychain_waits_on_its_ladder_only_when_sync_would_start() {
    for case in ["signed out", "local only", "unentitled"] {
        let rig = Rig::new();
        rig.backend.keychain_locked.store(true, Ordering::SeqCst);
        match case {
            "signed out" => rig.backend.signed_in.store(false, Ordering::SeqCst),
            "local only" => rig.gate.set_binding(VaultBinding::LocalOnly),
            _ => rig.gate.set_entitlement(Entitlement::Unentitled),
        }
        let supervisor = rig.start().await;
        sleep(Duration::from_secs(15 * 60)).await;
        let status = supervisor.status();
        assert_ne!(status.status, SyncStatusValue::Error, "{case}");
        assert_eq!(status.error_category, None, "{case}");
        assert_eq!(lock(&rig.backend.fact_reads).len(), 1, "{case}: no ladder");
    }
}

/// Low 11: the keychain answers again but the open then fails for another reason. The status
/// shows that failure, not the keychain.
#[tokio::test(start_paused = true)]
async fn a_keychain_that_answers_again_shows_the_next_failure() {
    let rig = Rig::new();
    rig.backend.keychain_locked.store(true, Ordering::SeqCst);
    let supervisor = rig.start().await;
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::KeychainUnavailable)
    );
    rig.backend.keychain_locked.store(false, Ordering::SeqCst);
    rig.backend.fail_open.store(true, Ordering::SeqCst);
    *lock(&rig.backend.open_error) = Some(SyncError::Api {
        source: ApiError::Status {
            status: 503,
            code: None,
            message: "unavailable".into(),
        },
    });
    rig.recovered.send(()).unwrap();
    settle().await;
    assert_eq!(rig.backend.opens(), 1);
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::ServerError)
    );
}

/// Medium 6: a stop that gives up on a loop stuck in a keychain prompt still stops its socket,
/// so the next supervisor of the vault is the only one connected (§9.3).
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_that_times_out_still_stops_the_socket() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let driver = std::sync::Arc::clone(&rig.backend.driver);
    assert_eq!(driver.live.load(Ordering::SeqCst), 1, "the socket is up");
    rig.backend.stall_facts.store(true, Ordering::SeqCst);
    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    let stopped = tokio::task::spawn_blocking(move || {
        supervisor.stop_blocking_within(Duration::from_millis(50))
    })
    .await
    .unwrap();
    assert!(!stopped, "the loop is still stuck");
    // A hang guard, not a timing bound: the socket ends on the stop, not on the loop.
    tokio::time::timeout(Duration::from_secs(30), async {
        while driver.live.load(Ordering::SeqCst) != 0 {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the socket ended while the loop stayed stuck");
}

/// Medium 6: a close then a reopen never holds two sockets: the stop returns once the old one
/// ended.
#[tokio::test(start_paused = true)]
async fn a_fast_close_and_reopen_never_holds_two_sockets() {
    let rig = Rig::new();
    let first = rig.start().await;
    let live = &rig.backend.driver.live;
    assert_eq!(live.load(Ordering::SeqCst), 1);
    first.stop().await;
    assert_eq!(live.load(Ordering::SeqCst), 0, "the old socket ended first");
    let _second = rig.start().await;
    assert_eq!(live.load(Ordering::SeqCst), 1);
}

/// Medium 7: a subscriber taken before the vault switch hears the rebuilt supervisor's latch.
#[tokio::test(start_paused = true)]
async fn auth_signals_survive_a_supervisor_rebuild() {
    let rig = Rig::new();
    let mut signals = rig.signals.subscribe();
    let first = rig.start().await;
    first.stop().await;
    let second = rig.start().await;
    second.hint_sink().hint(parse_frame(REVOKED_FRAME).unwrap());
    settle().await;
    assert_eq!(signals.try_recv(), Ok(AuthSignal::DeviceRevoked));
}

/// Low 8: a revocation aborts the pass under way, as `error-recovery-handler.ts:64` does.
#[tokio::test(start_paused = true)]
async fn a_revocation_aborts_the_running_pass() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    let finished = rig.backend.driver.finished.load(Ordering::SeqCst);
    supervisor.foreground();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    supervisor
        .hint_sink()
        .hint(parse_frame(REVOKED_FRAME).unwrap());
    settle().await;
    assert_eq!(rig.passes(), 2, "the second pass started");
    assert_eq!(
        rig.backend.driver.finished.load(Ordering::SeqCst),
        finished,
        "and was cut short"
    );
}

/// Low 9: Sync Now on a latched loop keeps the user's saved pause.
#[tokio::test(start_paused = true)]
async fn sync_now_on_a_latched_loop_keeps_the_pause() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.set_paused(true).await.unwrap();
    supervisor
        .hint_sink()
        .hint(parse_frame(REVOKED_FRAME).unwrap());
    settle().await;
    let (result, ()) = tokio::join!(supervisor.sync_now(), settle());
    assert_eq!(result.reason, Some(SyncNowBlockedReason::Failed));
    assert!(rig.db.read_blocking(pause::read).unwrap(), "still paused");
}

/// Low 10: a connected report from a socket the loop already let go of holds no tick back.
#[tokio::test(start_paused = true)]
async fn a_stale_socket_generation_is_ignored() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.note_socket(99, true);
    for _ in 0..2 {
        sleep(Duration::from_secs(60)).await;
        settle().await;
    }
    assert_eq!(rig.passes(), 3, "both ticks pulled");
}
