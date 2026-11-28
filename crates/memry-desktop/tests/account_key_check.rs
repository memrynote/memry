//! The master key against the account (#3536 N2), over a real `AccountService`, vault and
//! `memry-config.json` with the server scripted: a confirmed mismatch asks for recovery and signs
//! out the `integrity` way; a match, an unknown verifier and a flow in flight change nothing.

use std::sync::{Arc, Mutex};

use memry_core::api::auth::AuthState;
use memry_core::crypto::keys;
use memry_core::seams::secure_store::SecureStoreKey;
use memry_desktop::account::{AccountKeyCheck, VaultRecoveryReason};
use serde_json::{Value, json};

use crate::account_service::MASTER;
use crate::account_teardown::{ALL, Signed, count, signed_in};

fn verifier(master: [u8; 32]) -> String {
    keys::account_key_verifier(&master).unwrap()
}

fn set_sync(s: &Signed, sync: Value) {
    s.config
        .update(|c| {
            c.insert("sync".into(), sync);
            Ok::<_, memry_desktop::registry::config::ConfigError>(())
        })
        .unwrap();
}

fn cached_verifier(s: &Signed) -> Option<Value> {
    s.config.read(|c| {
        c.get("sync")
            .and_then(|s| s.get("accountKeyVerifier"))
            .cloned()
    })
}

/// Every reason the listener heard.
fn listen(s: &Signed) -> Arc<Mutex<Vec<VaultRecoveryReason>>> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    s.account
        .on_vault_recovery_needed(Arc::new(move |reason| sink.lock().unwrap().push(reason)));
    heard
}

fn assert_untouched(s: &Signed) {
    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert_eq!(s.account.session().state(), AuthState::Registered);
    assert_eq!(count(&s.open, "outbox"), 2);
}

/// `sync-core-handlers.ts:171-180`: the recovery prompt, then the integrity sign-out that keeps
/// the master key for the phrase to replace, the queue and the history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cached_verifier_of_another_key_asks_for_recovery_and_signs_out_keeping_the_queue() {
    let s = signed_in();
    set_sync(
        &s,
        json!({ "email": "a@b.c", "deviceId": "server-device", "recoveryPhraseConfirmed": true,
                "accountKeyVerifier": verifier([1; 32]) }),
    );
    let heard = listen(&s);

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Mismatch);
    assert_eq!(
        *heard.lock().unwrap(),
        vec![VaultRecoveryReason::VaultKeyMismatch]
    );
    assert!(s.keychain.has(SecureStoreKey::MasterKey));
    for key in ALL.into_iter().filter(|k| *k != SecureStoreKey::MasterKey) {
        assert!(!s.keychain.has(key), "{key:?} remains");
    }
    assert_eq!(s.account.session().state(), AuthState::SignedOut);
    assert!(!s.script.called("/auth/logout"));
    assert_eq!(count(&s.open, "outbox"), 2, "queued edits stay");
    assert_eq!(count(&s.open, "sync_history"), 1, "history stays");
}

/// No cached verifier: the server's is read, matches, and is cached for offline checks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_servers_verifier_matching_caches_it_and_changes_nothing() {
    let s = signed_in();
    s.script.answer(
        200,
        json!({ "kdfSalt": "c2FsdA==", "keyVerifier": verifier(MASTER) }),
    );
    let heard = listen(&s);

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Match);
    assert!(s.script.called("/auth/key-verifier"));
    assert_eq!(cached_verifier(&s), Some(json!(verifier(MASTER))));
    assert!(heard.lock().unwrap().is_empty());
    assert_untouched(&s);
}

/// The server's verifier for another key, fetched rather than cached, is a mismatch too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_servers_verifier_for_another_key_is_a_mismatch() {
    let s = signed_in();
    s.script.answer(
        200,
        json!({ "kdfSalt": "c2FsdA==", "keyVerifier": verifier([1; 32]) }),
    );
    let heard = listen(&s);

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Mismatch);
    assert_eq!(heard.lock().unwrap().len(), 1);
    assert_eq!(s.account.session().state(), AuthState::SignedOut);
}

/// A server that cannot answer leaves the verifier unknown: nothing acts on an uncertain read.
#[tokio::test(start_paused = true)]
async fn an_unreachable_verifier_is_unknown_and_deletes_nothing() {
    let s = signed_in();
    for _ in 0..4 {
        s.script.answer(500, json!({ "error": "INTERNAL" }));
    }
    let heard = listen(&s);

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Unknown);
    assert!(heard.lock().unwrap().is_empty());
    assert_eq!(cached_verifier(&s), None);
    assert_untouched(&s);
}

/// No master key (a device registered before its phrase) is unknown, never a mismatch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_master_key_is_unknown_and_asks_the_server_nothing() {
    let s = signed_in();
    memry_core::seams::secure_store::SecureStore::delete(
        s.keychain.as_ref(),
        SecureStoreKey::MasterKey,
    )
    .unwrap();

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Unknown);
    assert!(s.script.requests().is_empty());
    assert_eq!(s.account.session().state(), AuthState::Registered);
}

/// No registered device (`sync.deviceId`): nothing to check, nothing asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_registered_device_is_not_checked() {
    let s = signed_in();
    set_sync(
        &s,
        json!({ "email": "a@b.c", "accountKeyVerifier": verifier([1; 32]) }),
    );

    let check = s.account.check_sync_integrity(&s.session).await.unwrap();

    assert_eq!(check, AccountKeyCheck::Unknown);
    assert_untouched(&s);
}

/// A key-changing flow in flight is a transition; the integrity check waits for it to end and
/// then reads the final key.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flow_in_flight_is_a_transition_and_the_integrity_check_waits_for_it() {
    let s = signed_in();
    set_sync(
        &s,
        json!({ "email": "a@b.c", "deviceId": "server-device", "recoveryPhraseConfirmed": true,
                "accountKeyVerifier": verifier(MASTER) }),
    );
    let (public, _) = memry_core::crypto::sodium::sign_seed_keypair(&[7; 32]).unwrap();
    let release = s.script.held_answer(
        200,
        json!({ "devices": [{ "id": "server-device", "signingPublicKey": keys::base64_encode(&public), "revokedAt": null }] }),
    );
    let account = s.account.clone();
    let session = s.session.clone();
    let repair = tokio::spawn(async move { account.repair_device_keys(&session).await });
    while !s.script.called("/auth/devices") {
        tokio::task::yield_now().await;
    }

    assert_eq!(
        s.account.check_local_key_against_account().await,
        AccountKeyCheck::Transition
    );

    let account = s.account.clone();
    let session = s.session.clone();
    let integrity = tokio::spawn(async move { account.check_sync_integrity(&session).await });
    release.notify_one();
    repair.await.unwrap().unwrap();
    assert_eq!(
        integrity.await.unwrap().unwrap(),
        AccountKeyCheck::Match,
        "read after the flow"
    );
    assert_eq!(
        s.account.check_local_key_against_account().await,
        AccountKeyCheck::Match
    );
}

/// `raise_vault_recovery_needed` tells the listener only for the errors Electron prompts on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_recovery_needed_errors_raise_the_prompt() {
    let s = signed_in();
    let heard = listen(&s);

    assert!(
        s.account
            .raise_vault_recovery_needed("Current master key does not match this vault")
    );
    assert!(s.account.raise_vault_recovery_needed(
        "Master key not found in keychain — cannot create a local vault key while sync credentials exist"
    ));
    assert!(!s.account.raise_vault_recovery_needed(
        "Failed to retrieve key from keychain (master-key): OS keychain did not answer within 5000ms"
    ));
    assert!(!s.account.raise_vault_recovery_needed("network down"));

    assert_eq!(
        *heard.lock().unwrap(),
        vec![
            VaultRecoveryReason::VaultKeyMismatch,
            VaultRecoveryReason::MasterKeyMissing
        ]
    );
}
