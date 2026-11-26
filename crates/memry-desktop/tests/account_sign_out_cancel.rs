//! A sign-out cancelled at each of its waits leaves the account, the keys and the vault as they
//! were (#3536 c138). Electron's `teardownSession` (`sync/session-teardown.ts:36-170`) cannot be
//! cancelled; the nearest case is a quit mid-teardown, which deletes nothing before
//! `revokeServerSession` returns. Tauri drops a command's future only with its runtime
//! (`tauri::ipc::InvokeResolver::respond_async` spawns it), so the state checked here is what
//! the next launch restores.

use std::future::Future;
use std::sync::Arc;
use std::sync::mpsc;

use memry_core::api::auth::AuthState;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::account::SIGN_OUT_MARKER;
use memry_desktop::registry::VaultRegistry;
use serde_json::{Value, json};

use crate::account_teardown::{ALL, Signed, count, relaunch, signed_in};

/// Everything a finished sign-out changes.
#[derive(Debug, PartialEq)]
struct Snapshot {
    keys: Vec<Option<Vec<u8>>>,
    sync: Option<Value>,
    outbox: i64,
    history: i64,
    binding: String,
    marker: bool,
}

fn snapshot(s: &Signed) -> Snapshot {
    Snapshot {
        keys: ALL.map(|key| s.keychain.get(key).unwrap()).to_vec(),
        sync: s.config.read(|c| c.get("sync").cloned()),
        outbox: count(&s.open, "outbox"),
        history: count(&s.open, "sync_history"),
        binding: format!("{:?}", s.open.vault.account_binding().unwrap()),
        marker: s.config.path().with_file_name(SIGN_OUT_MARKER).exists(),
    }
}

async fn until(reached: impl Fn() -> bool) {
    while !reached() {
        tokio::task::yield_now().await;
    }
}

/// Drops `sign_out` once `reached` holds; it is polled first, so `|| true` cancels it at its
/// first wait.
async fn cancel_when(sign_out: impl Future, reached: impl Fn() -> bool) {
    tokio::select! {
        biased;
        _ = sign_out => panic!("the sign-out finished"),
        () = until(reached) => {}
    }
}

/// Signed in in this process and at the next launch (where `attach_if_signed_in` starts sync
/// again), with nothing of the account touched.
fn assert_kept(s: &Signed, before: &Snapshot) {
    assert_eq!(&snapshot(s), before);
    assert!(before.keys.iter().all(Option::is_some));
    assert_eq!(s.account.session().state(), AuthState::Registered);
    assert!(s.account.info().signed_in, "account_get_info");
    assert!(
        relaunch(&s.script, &s.keychain, &s.config).info().signed_in,
        "the next launch restores the session"
    );
}

/// The vault list refresh caches again: the cancelled sign-out's term is over.
async fn assert_refresh_caches(s: &Signed) {
    s.script.answer(200, json!({ "vaults": [] }));
    let registry = VaultRegistry::new(s.config.clone());
    s.account.refresh_vault_directory(&registry, true).await;
    let cached = s
        .config
        .read(|c| c["sync"].get("accountVaultsCache").cloned());
    assert!(cached.is_some(), "the list is cached");
}

/// Part 1: waiting behind a key operation (`key_op`). Nothing has run yet.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_behind_a_key_operation_changes_nothing() {
    let s = signed_in();
    let before = snapshot(&s);
    let material = s.script.held_answer(400, json!({ "error": "refused" }));
    let phrase = memry_core::crypto::recovery::generate_phrase().to_string();

    let cancelling = async {
        until(|| !s.script.requests().is_empty()).await;
        cancel_when(s.account.sign_out(&s.session), || true).await;
        material.notify_one();
    };
    let (linked, ()) = tokio::join!(s.account.link_via_recovery(phrase), cancelling);

    assert!(linked.is_err());
    assert!(!s.script.called("/auth/logout"));
    assert_kept(&s, &before);
    assert_refresh_caches(&s).await;
}

/// Part 2: stopping sync. The stop runs to its end off the async workers (Electron's
/// `stopSyncRuntime` runs first too); every secret and the account stay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_while_sync_stops_keeps_the_account() {
    let s = signed_in();
    let before = snapshot(&s);
    // An attach whose supervisor build waits holds the session lifecycle, so the stop waits.
    let (entered_tx, entered) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let released = std::sync::Mutex::new(released);
    let attaching = {
        let session = s.session.clone();
        std::thread::spawn(move || {
            session.attach_sync(Arc::new(move |_, _| {
                entered_tx.send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
                None
            }));
        })
    };
    entered.recv().unwrap();

    cancel_when(s.account.sign_out(&s.session), || true).await;
    release.send(()).unwrap();
    attaching.join().unwrap();

    assert!(!s.script.called("/auth/logout"));
    assert_kept(&s, &before);
    assert_refresh_caches(&s).await;
}

/// Part 4: revoking the server session. The core clears the keychain only after
/// `/auth/logout` returns (`AuthSession::sign_out`), as Electron deletes keys only after
/// `revokeServerSession`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_during_the_logout_keeps_every_secret_and_the_vault() {
    let s = signed_in();
    let before = snapshot(&s);
    let _logout = s.script.held_answer(200, json!({}));

    cancel_when(s.account.sign_out(&s.session), || {
        s.script.called("/auth/logout")
    })
    .await;

    assert_kept(&s, &before);
    assert_refresh_caches(&s).await;
}

/// The term's part A: while a sign-out waits on `/auth/logout` (the session still reads
/// `Registered`) a refresh starts no write and reads nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refresh_while_the_logout_waits_reads_nothing() {
    let s = signed_in();
    let _logout = s.script.held_answer(200, json!({}));
    let registry = VaultRegistry::new(s.config.clone());

    let refreshing = async {
        until(|| s.script.called("/auth/logout")).await;
        s.account.refresh_vault_directory(&registry, true).await
    };
    let refreshed = tokio::select! {
        biased;
        _ = s.account.sign_out(&s.session) => panic!("the sign-out finished"),
        refreshed = refreshing => refreshed,
    };

    assert!(!refreshed);
    assert_eq!(s.script.count("/sync/vaults"), 0);
}
