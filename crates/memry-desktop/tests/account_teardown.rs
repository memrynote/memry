//! Sign-out, revocation and the vault binding over a real vault, a real `data.db` and
//! `memry-config.json` (#3536 A4). The server is the scripted transport of `account_service`.

use std::sync::Arc;

use memry_core::api::auth::AuthState;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::binding::{Applied, BindingState};
use memry_desktop::account::session_events::AccountEvent;
use memry_desktop::account::{AccountService, device};
use memry_desktop::registry::VaultRegistry;
use memry_desktop::registry::config::AppConfig;
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::sync::signals::AuthSignal;
use serde_json::{Value, json};

use crate::account_service::{Keychain, MASTER, Script, access_token};

const ALL: [SecureStoreKey; 5] = [
    SecureStoreKey::MasterKey,
    SecureStoreKey::DeviceSigningKey,
    SecureStoreKey::AccessToken,
    SecureStoreKey::RefreshToken,
    SecureStoreKey::SetupToken,
];

struct Signed {
    _dir: tempfile::TempDir,
    script: Arc<Script>,
    keychain: Arc<Keychain>,
    config: Arc<AppConfig>,
    account: AccountService,
    session: Session,
    open: OpenVault,
}

/// A registered device with all five secrets, Electron's `sync` keys, and an open vault holding
/// two queued edits, a history row and this account's binding.
fn signed_in() -> Signed {
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
    let account = AccountService::new(
        script.clone(),
        keychain.clone(),
        "https://sync.test".into(),
        device::descriptor("1.0.0"),
        config.clone(),
    )
    .unwrap();
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

fn count(open: &OpenVault, table: &'static str) -> i64 {
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
}
