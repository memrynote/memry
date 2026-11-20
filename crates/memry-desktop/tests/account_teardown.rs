//! Sign-out, revocation and the vault binding over a real vault, a real `data.db` and
//! `memry-config.json` (#3536 A4). The server is the scripted transport of `account_service`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::auth::AuthState;
use memry_core::crypto::keys;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::binding::{Applied, BindingState};
use memry_desktop::account::session_events::AccountEvent;
use memry_desktop::account::vault_sync::{BINDING_RETRY, OpenVaultBinding, SyncWiring};
use memry_desktop::account::{AccountService, KeyRepair, device};
use memry_desktop::error::CoreError;
use memry_desktop::registry::VaultRegistry;
use memry_desktop::registry::config::AppConfig;
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::sync::signals::AuthSignal;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::account_service::{Keychain, MASTER, Script, access_token, jwt, setup_token};

pub(crate) const ALL: [SecureStoreKey; 5] = [
    SecureStoreKey::MasterKey,
    SecureStoreKey::DeviceSigningKey,
    SecureStoreKey::AccessToken,
    SecureStoreKey::RefreshToken,
    SecureStoreKey::SetupToken,
];

pub(crate) struct Signed {
    _dir: tempfile::TempDir,
    pub(crate) script: Arc<Script>,
    pub(crate) keychain: Arc<Keychain>,
    pub(crate) config: Arc<AppConfig>,
    pub(crate) account: Arc<AccountService>,
    pub(crate) session: Session,
    pub(crate) open: OpenVault,
}

/// A registered device with all five secrets, Electron's `sync` keys, and an open vault holding
/// two queued edits, a history row and this account's binding.
pub(crate) fn signed_in() -> Signed {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("app/memry-config.json")));
    config
        .update(|c| {
            c.insert(
                "sync".into(),
                json!({ "email": "a@b.c", "deviceId": "server-device", "recoveryPhraseConfirmed": true }),
            );
            Ok::<_, memry_desktop::registry::config::ConfigError>(())
        })
        .unwrap();
    let keychain = Arc::new(Keychain::holding_keys(Some(MASTER)));
    for (key, value) in [
        (SecureStoreKey::AccessToken, access_token("server-device")),
        (SecureStoreKey::RefreshToken, "refresh".to_owned()),
        (SecureStoreKey::SetupToken, "setup".to_owned()),
    ] {
        keychain.set(key, value.into_bytes()).unwrap();
    }
    let script = Arc::new(Script::default());
    let account = Arc::new(
        AccountService::new(
            script.clone(),
            keychain.clone(),
            "https://sync.test".into(),
            device::descriptor("1.0.0"),
            config.clone(),
        )
        .unwrap(),
    );
    assert_eq!(account.session().state(), AuthState::Registered);
    let session = Session::new(VaultRegistry::new(config.clone()));
    let path = dir.path().join("vault");
    std::fs::create_dir_all(&path).unwrap();
    session.open(&path, OpenSource::Select).unwrap();
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('task', 't', 'upsert', 1);
                 INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', 'n', 'crdt', 1);
                 INSERT INTO sync_history (id, kind, item_count, created_at) VALUES ('h', 'push', 1, 1);",
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    open.vault
        .set_account_binding(r#"{"userId":"u","mode":"sync"}"#)
        .unwrap();
    Signed {
        _dir: dir,
        script,
        keychain,
        config,
        account,
        session,
        open,
    }
}

pub(crate) fn count(open: &OpenVault, table: &'static str) -> i64 {
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap())
        })
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sign_out_deletes_the_five_secrets_and_empties_sync_and_keeps_the_queue() {
    let s = signed_in();
    s.script.answer(200, json!({}));

    let result = s.account.sign_out(&s.session).await.unwrap();

    assert_eq!(result.keychain_warning(), None);
    assert!(
        s.script.called("/auth/logout"),
        "the server session is revoked"
    );
    for key in ALL {
        assert!(!s.keychain.has(key), "{key:?} remains");
    }
    assert_eq!(s.account.session().state(), AuthState::SignedOut);
    let sync = s.config.read(|c| c.get("sync").cloned());
    assert_eq!(sync, Some(Value::Object(Default::default())));
    assert_eq!(count(&s.open, "outbox"), 2, "queued edits stay");
    assert_eq!(count(&s.open, "sync_history"), 0);
    assert!(s.open.vault.account_binding().unwrap().is_some());
}

/// A keychain that refuses some deletes still signs out (`teardownSession` signs out whatever
/// `deleteKey` answers, `session-teardown.ts:95-101`), names the entries that stay, and the
/// refresh token left behind does not read as signed in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sign_out_the_keychain_refuses_still_signs_out_and_names_what_stays() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain
        .refuse_delete(&[SecureStoreKey::MasterKey, SecureStoreKey::RefreshToken]);

    let result = s.account.sign_out(&s.session).await.unwrap();

    assert_eq!(result.keychain_failures, ["refresh-token", "master-key"]);
    assert_eq!(
        result.keychain_warning().as_deref(),
        Some("Failed to remove: refresh-token, master-key")
    );
    assert!(!s.account.info().signed_in, "account_get_info");
    assert_eq!(s.account.session().state(), AuthState::SignedOut);
    for key in [
        SecureStoreKey::DeviceSigningKey,
        SecureStoreKey::AccessToken,
        SecureStoreKey::SetupToken,
    ] {
        assert!(!s.keychain.has(key), "{key:?} remains");
    }
    let sync = s.config.read(|c| c.get("sync").cloned());
    assert_eq!(sync, Some(Value::Object(Default::default())));
}

/// After a sign-out that left the refresh token behind, signing in again in the same process
/// signs in: the session the user ended stays ended, and the new one is not refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signing_in_again_after_a_refused_sign_out_signs_in() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain
        .refuse_delete(&[SecureStoreKey::MasterKey, SecureStoreKey::RefreshToken]);
    s.account.sign_out(&s.session).await.unwrap();
    assert!(!s.account.info().signed_in);

    s.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));
    s.script.answer(
        200,
        json!({ "success": true, "setupToken": setup_token(), "needsSetup": false, "knownDevice": true }),
    );
    s.script.answer(
        200,
        json!({
            "kdfSalt": BASE64.encode([7u8; 16]),
            "keyVerifier": keys::account_key_verifier(&MASTER).unwrap(),
        }),
    );
    s.script.answer(
        200,
        json!({
            "success": true, "deviceId": "server-device-2",
            "accessToken": access_token("server-device-2"), "refreshToken": "refresh-2",
        }),
    );
    s.account
        .request_otp("kaan@example.com".into())
        .await
        .unwrap();
    let verified = s.account.verify_otp("123456".into()).await.unwrap();

    assert_eq!(verified.device_id.as_deref(), Some("server-device-2"));
    assert!(s.account.info().signed_in, "account_get_info");
    assert!(
        relaunch(&s.script, &s.keychain, &s.config).info().signed_in,
        "the next launch restores the new session"
    );
}

/// The next launch's account service over the same keychain and `memry-config.json`.
pub(crate) fn relaunch(
    script: &Arc<Script>,
    keychain: &Arc<Keychain>,
    config: &Arc<AppConfig>,
) -> AccountService {
    AccountService::new(
        script.clone(),
        keychain.clone(),
        "https://sync.test".into(),
        device::descriptor("1.0.0"),
        Arc::new(AppConfig::load(config.path().to_path_buf())),
    )
    .unwrap()
}

/// #4767: the refresh token a refused sign-out left behind does not sign the user back in at
/// the next launch, and signing in again then lets the launch after it restore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_sign_out_stays_signed_out_after_a_relaunch() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain
        .refuse_delete(&[SecureStoreKey::MasterKey, SecureStoreKey::RefreshToken]);
    s.account.sign_out(&s.session).await.unwrap();
    assert!(s.keychain.has(SecureStoreKey::RefreshToken));

    let next = relaunch(&s.script, &s.keychain, &s.config);

    assert_eq!(next.session().state(), AuthState::SignedOut);
    assert!(!next.info().signed_in, "account_get_info");
}

/// A config from before the `sync` key, and Electron's default `sync: {}`, both restore a
/// session the keychain holds: no marker file, no refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_install_without_a_marker_restores_whatever_its_config_holds() {
    for config_json in ["{}", r#"{"sync":{}}"#] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, config_json).unwrap();
        let config = Arc::new(AppConfig::load(path));
        let keychain = Arc::new(Keychain::holding_keys(Some(MASTER)));
        keychain
            .set(
                SecureStoreKey::AccessToken,
                access_token("server-device").into_bytes(),
            )
            .unwrap();
        keychain
            .set(SecureStoreKey::RefreshToken, b"refresh".to_vec())
            .unwrap();

        let account = relaunch(&Arc::new(Script::default()), &keychain, &config);

        assert_eq!(
            account.session().state(),
            AuthState::Registered,
            "{config_json}"
        );
        assert!(account.info().signed_in, "{config_json}");
    }
}

struct Offline;

impl Reachability for Offline {
    fn current(&self) -> Reachable {
        Reachable::Offline
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// `BINDING_RETRY_MS`: a vault list that cannot be read holds the vault as `Unknown`, which
/// reports nothing, and the check runs again a minute later; its answer is reported once and
/// never asked again.
#[tokio::test(start_paused = true)]
async fn an_unknown_binding_is_checked_again_after_a_minute_and_reported_once() {
    let s = signed_in();
    s.open.vault.set_account_binding("not json").unwrap();
    std::fs::write(s.open.path.join("note.md"), "# mine\n").unwrap();
    // A list it cannot read (a 5xx is retried inside the client first).
    s.script.answer(200, json!({ "vaults": "none" }));
    s.script.answer(200, json!([]));
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let wiring = Arc::new(SyncWiring {
        runtime: tokio::runtime::Handle::current(),
        account: s.account.clone(),
        registry: s.session.registry().clone(),
        store: s.keychain.clone(),
        reachability: Arc::new(Offline),
        power: None,
        keychain_recovered: broadcast::Sender::new(4),
        telemetry: None,
        on_status: Arc::new(|_| {}),
        on_event: Arc::new(|_| {}),
        bindings: Arc::new(OpenVaultBinding::default()),
        on_binding: Arc::new(move |state| seen.lock().unwrap().push(state.clone())),
        on_vault_list_changed: Arc::new(|| {}),
        tier: None,
        on_gate: Arc::new(|_| {}),
    });
    let start = tokio::time::Instant::now();
    let session = s.session.clone();
    let factory = wiring.clone().factory();
    tokio::task::spawn_blocking(move || session.attach_sync(factory))
        .await
        .unwrap();

    let decided = BindingState::NeedsDecision {
        account_vault_count: 0,
        merge_target: None,
    };
    for _ in 0..1_000 {
        if changes.lock().unwrap().last() == Some(&decided) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The neutral state is `Bound` until the first decision, so the unreadable list's
    // `Unknown` is reported, once, before the retry decides.
    let reported = vec![BindingState::Unknown, decided.clone()];
    assert_eq!(*changes.lock().unwrap(), reported);
    assert!(start.elapsed() >= BINDING_RETRY, "{:?}", start.elapsed());
    assert_eq!(s.script.count("/sync/vaults"), 2);

    tokio::time::sleep(BINDING_RETRY * 10).await;
    assert_eq!(s.script.count("/sync/vaults"), 2, "a decision is final");
    assert_eq!(*changes.lock().unwrap(), reported);
    let session = s.session.clone();
    tokio::task::spawn_blocking(move || session.detach_sync())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_keeps_every_secret_and_the_queue_and_counts_it() {
    let s = signed_in();

    let event = s
        .account
        .on_auth_signal(&s.session, AuthSignal::DeviceRevoked)
        .await;

    assert_eq!(event, AccountEvent::DeviceRevoked { unsynced_count: 2 });
    assert_eq!(s.account.session().state(), AuthState::Revoked);
    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert_eq!(count(&s.open, "outbox"), 2);
    assert!(s.session.sync_supervisor().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vault_bound_to_another_account_is_held_foreign_without_asking_the_server() {
    let s = signed_in();
    s.open
        .vault
        .set_account_binding(r#"{"userId":"someone-else","mode":"sync"}"#)
        .unwrap();
    let registry = VaultRegistry::new(s.config.clone());

    let applied = s
        .account
        .apply_open_vault_binding(&s.open, &registry)
        .await
        .unwrap();

    assert_eq!(applied, Applied::Held(BindingState::Foreign));
    assert_eq!(
        BindingState::Foreign.gate(),
        memry_desktop::sync::gate::VaultBinding::Foreign
    );
    assert!(!s.script.called("/sync/vaults"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_unbound_vault_binds_to_its_own_id_and_mirrors_the_registry() {
    let s = signed_in();
    s.open.vault.set_account_binding("not json").unwrap();
    let registry = VaultRegistry::new(s.config.clone());

    let applied = s
        .account
        .apply_open_vault_binding(&s.open, &registry)
        .await
        .unwrap();

    assert_eq!(applied, Applied::Start);
    assert_eq!(
        s.open.vault.account_binding().unwrap().as_deref(),
        Some(r#"{"userId":"u","mode":"sync"}"#)
    );
    assert_eq!(
        s.open.vault.server_vault_id().unwrap(),
        Some(s.open.vault.id())
    );
    let mirrored = registry
        .get(&s.open.path.to_string_lossy())
        .and_then(|v| v.account_binding)
        .map(|b| (b.user_id, b.mode));
    assert_eq!(mirrored, Some(("u".into(), "sync".into())));
    assert_eq!(
        registry
            .get(&s.open.path.to_string_lossy())
            .and_then(|v| v.vault_uuid),
        Some(s.open.vault.id()),
        "the id lands in the same write as the binding mirror"
    );
}

/// #4766: the next account never signs in with the device key a refused sign-out kept: the
/// first step of the next sign-in replaces it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_sign_in_replaces_a_device_key_the_keychain_refused_to_delete() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain
        .refuse_delete(&[SecureStoreKey::DeviceSigningKey]);
    let kept = s.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap();
    s.account.sign_out(&s.session).await.unwrap();
    assert_eq!(
        s.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap(),
        kept
    );

    s.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));
    s.account.request_otp("b@example.com".into()).await.unwrap();

    let now = s.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap();
    assert!(now.is_some());
    assert_ne!(now, kept);
}

/// A clear that fails once while every entry then deletes on its own is a finished sign-out:
/// no "did not finish" warning.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clear_that_fails_once_signs_out_without_a_warning() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain.refuse_next_clear();

    let result = s.account.sign_out(&s.session).await.unwrap();

    assert_eq!(s.account.session().state(), AuthState::SignedOut);
    assert!(ALL.iter().all(|key| !s.keychain.has(*key)));
    assert_eq!(result.keychain_warning(), None);
}

/// A sign-out while adoption waits on the account's vault list binds nothing: the next account
/// would otherwise find the vault bound to this one's server vault.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sign_out_during_adoption_binds_nothing() {
    let s = signed_in();
    let open = &s.open;
    open.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch("DELETE FROM outbox; DELETE FROM sync_history;")
                .unwrap();
            Ok(())
        })
        .unwrap();
    let held = s.script.held_answer(
        200,
        json!({ "vaults": [{ "vaultUuid": "server-vault-a", "itemCount": 3, "createdAt": 1 }] }),
    );
    s.script.answer(200, json!({}));

    let signing_out = async {
        while s.script.count("/sync/vaults") == 0 {
            tokio::task::yield_now().await;
        }
        s.account.sign_out(&s.session).await.unwrap();
        held.notify_one();
    };
    let (adopted, ()) = tokio::join!(s.account.adopt_account_vault_if_absent(open), signing_out);

    assert_eq!(adopted.unwrap(), None);
    assert_eq!(open.vault.server_vault_id().unwrap(), None);
}

/// A clear that failed while every entry then deleted on its own leaves nothing to sweep: the
/// key a local write mints after the sign-out survives the next sign-in, so offline edits keep
/// this device's id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_key_minted_after_a_sign_out_whose_entries_all_went_is_kept() {
    let s = signed_in();
    s.script.answer(200, json!({}));
    s.keychain.refuse_next_clear();
    s.account.sign_out(&s.session).await.unwrap();
    memry_core::api::auth::ensure_device_identity(s.keychain.clone()).unwrap();
    let minted = s.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap();

    s.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));
    s.account.request_otp("b@example.com".into()).await.unwrap();

    assert!(minted.is_some());
    assert_eq!(
        s.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap(),
        minted
    );
}

/// A sign-out whose keychain kept the tokens is still a sign-out: the binding decision binds
/// nothing on them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sign_out_whose_keychain_kept_the_tokens_binds_nothing() {
    let s = signed_in();
    s.open.vault.set_account_binding("not json").unwrap();
    s.script.answer(200, json!({}));
    s.keychain
        .refuse_delete(&[SecureStoreKey::AccessToken, SecureStoreKey::RefreshToken]);
    s.account.sign_out(&s.session).await.unwrap();
    s.script.answer(200, json!({ "vaults": [] }));
    let registry = VaultRegistry::new(s.config.clone());

    let applied = s
        .account
        .apply_open_vault_binding(&s.open, &registry)
        .await
        .unwrap();

    assert_eq!(applied, Applied::Held(BindingState::Unknown));
    assert_eq!(s.open.vault.server_vault_id().unwrap(), None);
}

/// `GET /auth/devices` with this install's device key (`Keychain::holding_keys`) under `id`.
fn devices(id: &str, revoked_at: Value) -> Value {
    let (public, _) = memry_core::crypto::sodium::sign_seed_keypair(&[7; 32]).unwrap();
    json!({ "devices": [{ "id": id, "signingPublicKey": keys::base64_encode(&public), "revokedAt": revoked_at }] })
}

/// The account still lists this install's key: only `sync.deviceId` was lost, and it comes back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listed_device_key_restores_the_device_id_and_keeps_every_secret() {
    let s = signed_in();
    s.config
        .update(|c| {
            c.insert("sync".into(), json!({ "email": "a@b.c" }));
            Ok::<_, memry_desktop::registry::config::ConfigError>(())
        })
        .unwrap();
    s.script
        .answer(200, devices("server-device-7", Value::Null));

    let repaired = s.account.repair_device_keys(&s.session).await.unwrap();

    assert_eq!(repaired, KeyRepair::Listed);
    let device_id = s
        .config
        .read(|c| c.get("sync").and_then(|s| s.get("deviceId")).cloned());
    assert_eq!(device_id, Some(json!("server-device-7")));
    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert_eq!(s.account.session().state(), AuthState::Registered);
}

/// A key only a revoked device holds cannot sign again: the device signs out keeping its master
/// key, its queue, its sync state and its history, and revokes no server session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unlisted_device_key_signs_out_keeping_the_master_key_and_the_queue() {
    let s = signed_in();
    s.script
        .answer(200, devices("server-device", json!(1_700_000_000)));

    let repaired = s.account.repair_device_keys(&s.session).await.unwrap();

    assert_eq!(repaired, KeyRepair::SignInRequired);
    assert!(s.keychain.has(SecureStoreKey::MasterKey));
    for key in ALL.into_iter().filter(|k| *k != SecureStoreKey::MasterKey) {
        assert!(!s.keychain.has(key), "{key:?} remains");
    }
    assert_eq!(s.account.session().state(), AuthState::SignedOut);
    assert!(!s.script.called("/auth/logout"));
    assert_eq!(count(&s.open, "outbox"), 2, "queued edits stay");
    assert_eq!(count(&s.open, "sync_history"), 1, "history stays");
    let sync = s.config.read(|c| c.get("sync").cloned());
    assert_eq!(sync, Some(Value::Object(Default::default())));
}

/// A keychain that does not answer is not a lost key: nothing is deleted and nothing is asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locked_keychain_is_keychain_unavailable_and_deletes_nothing() {
    let s = signed_in();
    s.keychain
        .access_locked
        .store(true, std::sync::atomic::Ordering::SeqCst);

    let error = s.account.repair_device_keys(&s.session).await.unwrap_err();

    assert_eq!(error.kind_and_code().1, "keychain_unavailable");
    s.keychain
        .access_locked
        .store(false, std::sync::atomic::Ordering::SeqCst);
    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert!(s.script.requests().is_empty());
}

/// A server that cannot answer is not a revoked device: the user retries, nothing is deleted.
#[tokio::test(start_paused = true)]
async fn a_failing_device_list_deletes_nothing() {
    let s = signed_in();
    for _ in 0..4 {
        s.script.answer(500, json!({ "error": "INTERNAL" }));
    }

    s.account.repair_device_keys(&s.session).await.unwrap_err();

    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert_eq!(s.account.session().state(), AuthState::Registered);
    assert!(
        s.config
            .read(|c| c.get("sync").and_then(|s| s.get("deviceId")).is_some())
    );
}

/// An expired access token with no refresh token is a session that cannot come back: the device
/// signs out the `integrity` way without asking the server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_cannot_refresh_signs_out_keeping_the_master_key() {
    let s = signed_in();
    s.keychain
        .set(
            SecureStoreKey::AccessToken,
            jwt(json!({ "sub": "u", "device_id": "server-device", "exp": 1 })).into_bytes(),
        )
        .unwrap();
    s.keychain.delete(SecureStoreKey::RefreshToken).unwrap();

    let repaired = s.account.repair_device_keys(&s.session).await.unwrap();

    assert_eq!(repaired, KeyRepair::SignInRequired);
    assert!(s.keychain.has(SecureStoreKey::MasterKey));
    assert!(!s.keychain.has(SecureStoreKey::DeviceSigningKey));
    assert!(s.script.requests().is_empty());
    assert_eq!(count(&s.open, "outbox"), 2);
}

/// A refresh token the keychain refused to delete in an integrity sign-out does not sign the
/// device back in at the next launch, and the next account's sign-in removes what stayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_delete_in_a_repair_stays_signed_out_after_a_relaunch() {
    let s = signed_in();
    s.script
        .answer(200, devices("server-device", json!(1_700_000_000)));
    s.keychain.refuse_delete(&[SecureStoreKey::RefreshToken]);

    s.account.repair_device_keys(&s.session).await.unwrap();
    assert!(s.keychain.has(SecureStoreKey::RefreshToken));
    let next = relaunch(&s.script, &s.keychain, &s.config);

    assert_eq!(next.session().state(), AuthState::SignedOut);
    s.keychain.undeletable.lock().unwrap().clear();
    s.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));
    next.request_otp("b@example.com".into()).await.unwrap();
    assert!(!s.keychain.has(SecureStoreKey::RefreshToken));
}

/// A repair that signs out ends the account's term: an adoption waiting on the vault list binds
/// nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repair_that_signs_out_during_adoption_binds_nothing() {
    let s = signed_in();
    let open = &s.open;
    open.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch("DELETE FROM outbox; DELETE FROM sync_history;")
                .unwrap();
            Ok(())
        })
        .unwrap();
    let held = s.script.held_answer(
        200,
        json!({ "vaults": [{ "vaultUuid": "server-vault-a", "itemCount": 3, "createdAt": 1 }] }),
    );
    s.script
        .answer(200, devices("server-device", json!(1_700_000_000)));

    let repairing = async {
        while s.script.count("/sync/vaults") == 0 {
            tokio::task::yield_now().await;
        }
        let repaired = s.account.repair_device_keys(&s.session).await.unwrap();
        held.notify_one();
        repaired
    };
    let (adopted, repaired) =
        tokio::join!(s.account.adopt_account_vault_if_absent(open), repairing);

    assert_eq!(repaired, KeyRepair::SignInRequired);
    assert_eq!(adopted.unwrap(), None);
    assert_eq!(open.vault.server_vault_id().unwrap(), None);
}

/// A refresh the server refused once is held back for a while, not ended: the repair is an error
/// the user retries, and nothing is deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_back_refresh_never_signs_out() {
    let s = signed_in();
    s.keychain
        .set(
            SecureStoreKey::AccessToken,
            jwt(json!({ "sub": "u", "device_id": "server-device", "exp": 1 })).into_bytes(),
        )
        .unwrap();
    s.script
        .answer(401, json!({ "error": "INVALID_REFRESH_TOKEN" }));

    s.account.repair_device_keys(&s.session).await.unwrap_err();

    for key in ALL {
        assert!(s.keychain.has(key), "{key:?} was deleted");
    }
    assert_eq!(s.script.count("/auth/devices"), 0);
}

/// A setup call on a device that is already signed in is refused, and the account's master key
/// stays: only a device that needs setup drops a kept key.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_setup_on_a_signed_in_device_is_refused_and_keeps_the_master_key() {
    let s = signed_in();

    s.account.setup_new_account().await.unwrap_err();

    assert_eq!(
        s.keychain
            .get(SecureStoreKey::MasterKey)
            .unwrap()
            .as_deref(),
        Some(&MASTER[..])
    );
    assert_eq!(s.account.session().state(), AuthState::Registered);
    assert!(s.account.info().signed_in);
}
