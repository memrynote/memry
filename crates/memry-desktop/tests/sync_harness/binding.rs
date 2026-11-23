//! The account side of sync against the real Worker, through the shell's wiring
//! ([`SyncWiring`] attached to a real `Session`): a vault one account synced holds as `Foreign`
//! for the next account and never runs a pass (`vault-account-binding.ts:79-110`), a device
//! the account revokes stops sync and reports one event that keeps its keys
//! (`DeviceRevokedEvent`, D7), and a vault merged into the account's vault restamps the records
//! it wrote under its local id once (#5535).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::domain::canvas::{self, NewCanvas};
use memry_core::domain::canvas_folder;
use memry_core::seams::reachability::Reachability;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::Db;
use memry_core::sync::outbox;
use memry_desktop::account::AccountService;
use memry_desktop::account::binding::{
    Applied, BindingChoice, BindingMode, BindingState, StoredBinding, write_binding,
};
use memry_desktop::account::session_events::{self, AccountEvent};
use memry_desktop::account::vault_sync::{OpenVaultBinding, SyncWiring};
use memry_desktop::registry::config::AppConfig;
use memry_desktop::registry::vaults::VaultRegistry;
use memry_desktop::session::Session;
use memry_desktop::vault::consumer::VaultTier;
use tokio::sync::broadcast;

use super::account::{CODE, install};
use super::{Online, Server, device_key};

const OTHER: &str = "Harness-Other@Example.com";

pub(super) fn wiring(
    account: &Arc<AccountService>,
    store: &Arc<dyn SecureStore>,
    session: &Session,
) -> (Arc<SyncWiring>, Arc<Mutex<Vec<BindingState>>>) {
    wiring_with_tier(account, store, session, None)
}

/// [`wiring`] with the vault tier pulled bodies reach the disk through, as the app wires it.
pub(super) fn wiring_with_tier(
    account: &Arc<AccountService>,
    store: &Arc<dyn SecureStore>,
    session: &Session,
    tier: Option<Arc<VaultTier>>,
) -> (Arc<SyncWiring>, Arc<Mutex<Vec<BindingState>>>) {
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let wiring = Arc::new(SyncWiring {
        runtime: tokio::runtime::Handle::current(),
        account: account.clone(),
        registry: session.registry().clone(),
        store: store.clone(),
        reachability: Arc::new(Online) as Arc<dyn Reachability>,
        power: None,
        keychain_recovered: broadcast::Sender::new(4),
        telemetry: None,
        on_status: Arc::new(|_| {}),
        on_event: Arc::new(|_| {}),
        bindings: Arc::new(OpenVaultBinding::default()),
        on_binding: Arc::new(move |state| seen.lock().unwrap().push(state.clone())),
        on_vault_list_changed: Arc::new(|| {}),
        tier,
        on_gate: Arc::new(|_| {}),
    });
    (wiring, changes)
}

pub(super) async fn attach(session: &Session, wiring: &Arc<SyncWiring>) {
    let session = session.clone();
    let factory = wiring.clone().factory();
    tokio::task::spawn_blocking(move || session.attach_sync(factory))
        .await
        .unwrap();
}

pub(super) async fn detach(session: &Session) {
    let session = session.clone();
    tokio::task::spawn_blocking(move || session.detach_sync())
        .await
        .unwrap();
}

/// Waits for the binding decision itself: `OpenVaultBinding::state()` reads `Bound` before the
/// first decision (`vault-account-binding.ts:140-141`), so only `on_binding`'s log shows it.
pub(super) async fn wait_for_binding(changes: &Mutex<Vec<BindingState>>, want: &BindingState) {
    for _ in 0..120 {
        if changes.lock().unwrap().last() == Some(want) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!(
        "the binding never became {want:?}: {:?}",
        changes.lock().unwrap()
    );
}

/// A new account on `store`, set up and confirmed, on a paid plan, and its phrase.
pub(super) async fn new_account(
    server: &mut Server,
    store: Arc<dyn SecureStore>,
    email: &str,
) -> (tempfile::TempDir, Arc<AccountService>, String) {
    let (dir, account) = install(server, store);
    let phrase = set_up(server, &account, email).await;
    (dir, Arc::new(account), phrase)
}

/// `email` signs in on `account` as a new account, set up and confirmed, on a paid plan.
async fn set_up(server: &mut Server, account: &AccountService, email: &str) -> String {
    account.request_otp(email.into()).await.expect("a code");
    server.otp(email, CODE);
    assert!(account.verify_otp(CODE.into()).await.unwrap().needs_setup);
    account.setup_new_account().await.expect("setup");
    let phrase = account.recovery_phrase().expect("the phrase").to_string();
    account.confirm_recovery_phrase(true).unwrap();
    server.entitle(email);
    phrase
}

pub(super) fn open_session(dir: &tempfile::TempDir) -> Session {
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(dir.path().join("vaults.json"))));
    let session = Session::new(registry);
    session.create(dir.path(), "Mine").expect("a vault");
    session
}

#[tokio::test(flavor = "multi_thread")]
async fn a_vault_one_account_synced_holds_foreign_for_the_next_and_runs_no_pass() {
    let mut server = Server::start();
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);

    let a_store = device_key::with_device_key();
    let (_a_dir, a, _) = new_account(&mut server, a_store.clone(), super::account::EMAIL).await;
    let (a_wiring, a_changes) = wiring(&a, &a_store, &session);
    attach(&session, &a_wiring).await;
    wait_for_binding(&a_changes, &BindingState::Bound).await;
    assert_eq!(*a_changes.lock().unwrap(), vec![BindingState::Bound]);
    detach(&session).await;
    assert_eq!(a_wiring.bindings.state(), BindingState::Bound, "neutral");

    let b_store = device_key::with_device_key();
    let (_b_dir, b, _) = new_account(&mut server, b_store.clone(), OTHER).await;
    let (b_wiring, b_changes) = wiring(&b, &b_store, &session);
    attach(&session, &b_wiring).await;
    wait_for_binding(&b_changes, &BindingState::Foreign).await;
    assert_eq!(*b_changes.lock().unwrap(), vec![BindingState::Foreign]);

    let supervisor = session.sync_supervisor().expect("a supervisor");
    let answer = supervisor.sync_now().await;
    assert!(!answer.success, "{answer:?}");
    assert_eq!(supervisor.completed_pulls(), 0, "no pass ran");
    detach(&session).await;
}

/// A vault the last account edited but never bound is held `Foreign` for the next account on
/// this install: sign-out deletes the device key, so the next sign-in stamps a new device id and
/// the last account's ticks read as another device's (`vault-account-binding.ts:79-110`).
#[tokio::test(flavor = "multi_thread")]
async fn after_sign_out_an_unbound_vault_the_last_account_edited_holds_foreign() {
    let mut server = Server::start();
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let store = device_key::with_device_key();
    let (_dir, account, _) = new_account(&mut server, store.clone(), super::account::EMAIL).await;
    let open = session.current().unwrap();
    let tasks = open.vault.tasks(store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Home".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    tasks
        .create(NewTaskInput {
            title: "Call the bank".into(),
            project_id: project,
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .unwrap();
    drop(tasks);

    account.sign_out(&session).await.expect("signed out");
    set_up(&mut server, &account, OTHER).await;

    let applied = account
        .apply_open_vault_binding(&open, session.registry())
        .await
        .unwrap();
    assert_eq!(applied, Applied::Held(BindingState::Foreign));
    assert_eq!(open.vault.account_binding().unwrap(), None, "never bound");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_device_stops_sync_once_and_keeps_its_keys_and_queue() {
    let mut server = Server::start();
    let a_store = device_key::with_device_key();
    let (_a_dir, a, phrase) =
        new_account(&mut server, a_store.clone(), super::account::EMAIL).await;

    // The second device: the same account, its own device key, linked with the phrase.
    let b_store = device_key::without_device_key();
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let (_b_dir, b) = install(&server, b_store.clone());
    b.request_otp(super::account::EMAIL.into()).await.unwrap();
    server.otp(super::account::EMAIL, CODE);
    assert!(
        b.verify_otp(CODE.into())
            .await
            .unwrap()
            .needs_recovery_input
    );
    let device_id = b.link_via_recovery(phrase).await.expect("linked");
    let b = Arc::new(b);

    let events = Arc::new(Mutex::new(Vec::new()));
    let heard = events.clone();
    session_events::listen(
        &tokio::runtime::Handle::current(),
        b.clone(),
        session.clone(),
        session.subscribe_auth_signals(),
        move |event| heard.lock().unwrap().push(event),
    );
    let (b_wiring, b_changes) = wiring(&b, &b_store, &session);
    attach(&session, &b_wiring).await;
    wait_for_binding(&b_changes, &BindingState::Bound).await;
    let open = session.current().unwrap();
    b.session()
        .register_vault(
            open.vault.server_vault_id().unwrap().unwrap(),
            "Mine".into(),
        )
        .await
        .expect("the vault is on the account");

    a.remove_device(device_id).await.expect("revoked");
    // The socket's close 4004 can stop sync first; otherwise a pass meets the 403.
    if let Some(supervisor) = session.sync_supervisor() {
        let _ = supervisor.sync_now().await;
    }
    for _ in 0..120 {
        if !events.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let queued = open.vault.db_handle().read(outbox::depth).await.unwrap() as u64;
    assert_eq!(
        *events.lock().unwrap(),
        vec![AccountEvent::DeviceRevoked {
            unsynced_count: queued
        }]
    );
    assert!(session.sync_supervisor().is_none(), "sync stopped");
    assert!(b_store.get(SecureStoreKey::MasterKey).unwrap().is_some());
    assert!(b_store.get(SecureStoreKey::RefreshToken).unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn after_sign_in_an_empty_vault_adopts_the_accounts_vault_and_one_with_notes_keeps_its_own() {
    const HOME: &str = "0b9f3c8e-5d4a-4c1e-9a7b-2f6e8d1c3a50";
    let mut server = Server::start();
    let a_store = device_key::with_device_key();
    let (_a_dir, a, phrase) =
        new_account(&mut server, a_store.clone(), super::account::EMAIL).await;
    a.session()
        .register_vault(HOME.into(), "Home".into())
        .await
        .expect("the vault is on the account");

    let b_store = device_key::without_device_key();
    let (_b_dir, b) = install(&server, b_store.clone());
    b.request_otp(super::account::EMAIL.into()).await.unwrap();
    server.otp(super::account::EMAIL, CODE);
    assert!(
        b.verify_otp(CODE.into())
            .await
            .unwrap()
            .needs_recovery_input
    );
    b.link_via_recovery(phrase).await.expect("linked");

    let with_notes = tempfile::tempdir().unwrap();
    let kept = open_session(&with_notes);
    let open = kept.current().unwrap();
    std::fs::write(open.path.join("note.md"), "# mine\n").unwrap();
    assert_eq!(b.adopt_account_vault_if_absent(&open).await.unwrap(), None);
    assert_eq!(open.vault.server_vault_id().unwrap(), None, "its own id");

    let empty = tempfile::tempdir().unwrap();
    let session = open_session(&empty);
    let open = session.current().unwrap();
    assert_eq!(
        b.adopt_account_vault_if_absent(&open)
            .await
            .unwrap()
            .as_deref(),
        Some(HOME)
    );
    assert_eq!(open.vault.server_vault_id().unwrap().as_deref(), Some(HOME));
    assert_eq!(
        b.adopt_account_vault_if_absent(&open).await.unwrap(),
        None,
        "once"
    );
}

/// #5535: a vault with content merged into the account's vault states the account vault's id in
/// every live canvas and canvas folder it made before the bind, queued once; a deleted canvas is
/// never queued, and the next start queues nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_merge_restamps_the_canvases_made_before_it_once_and_never_a_deleted_one() {
    const HOME: &str = "6d2f0a41-8c3b-4e7a-b915-3a7c0e9d2b64";
    let mut server = Server::start();
    let store = device_key::with_device_key();
    let (_dir, account, _) = new_account(&mut server, store.clone(), super::account::EMAIL).await;
    account
        .session()
        .register_vault(HOME.into(), "Home".into())
        .await
        .expect("the vault is on the account");

    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let open = session.current().unwrap();
    std::fs::write(open.path.join("note.md"), "# mine\n").unwrap();
    let local = open.vault.id();
    let device = account.session().local_device_id().unwrap();
    let db = open.vault.db_handle();
    {
        let (local, device) = (local.clone(), device.clone());
        db.call_blocking(move |conn| {
            for id in ["drawn", "dropped"] {
                let new = NewCanvas {
                    id: Some(id),
                    title: Some(id),
                    owner_note_id: None,
                    scene: None,
                    folder: None,
                    icon: None,
                };
                canvas::create(conn, &new, &local, &device, 1)?;
            }
            canvas::delete(conn, "dropped", &device, 2)?;
            canvas_folder::upsert(conn, &local, "Work", None, &device, 3)?;
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
    }
    let stated = |item_type, id| stated(&db, item_type, id);

    let Applied::Held(state) = account
        .apply_open_vault_binding(&open, session.registry())
        .await
        .unwrap()
    else {
        panic!("a vault with content waits for the user");
    };
    assert!(
        matches!(state, BindingState::NeedsDecision { .. }),
        "{state:?}"
    );
    let bound = account
        .resolve_open_vault_binding(&open, session.registry(), &state, BindingChoice::Merge)
        .unwrap();
    assert_eq!(bound, BindingState::Bound);
    assert_eq!(open.vault.server_vault_id().unwrap().as_deref(), Some(HOME));
    assert_eq!(stated("canvas", "drawn"), (HOME.to_owned(), 1));
    assert_eq!(stated("canvas_folder", "cvf_work"), (HOME.to_owned(), 1));
    assert_eq!(stated("canvas", "dropped"), (local.clone(), 0), "deleted");

    db.call_blocking(|conn| {
        conn.execute("DELETE FROM outbox", []).unwrap();
        Ok(())
    })
    .unwrap();
    let applied = account
        .apply_open_vault_binding(&open, session.registry())
        .await
        .unwrap();
    assert_eq!(applied, Applied::Start);
    assert_eq!(stated("canvas", "drawn"), (HOME.to_owned(), 0), "once");
    assert_eq!(
        stated("canvas_folder", "cvf_work"),
        (HOME.to_owned(), 0),
        "once"
    );
}

/// The `vaultId` `(item_type, id)` states and how many outbox rows it has.
fn stated(db: &Db, item_type: &'static str, id: &'static str) -> (String, i64) {
    db.read_blocking(move |conn| {
        let payload: String = conn
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [item_type, id],
                |row| row.get(0),
            )
            .unwrap();
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = ?1 AND item_id = ?2",
                [item_type, id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        Ok((payload["vaultId"].as_str().unwrap().to_owned(), queued))
    })
    .unwrap()
}

/// #5535 at a start (REVIEW-5581 low 2): a vault a build before the restamp bound for sync left
/// bound with no restamp flag and a canvas stating the local id. The next start's
/// `Decision::Start { bind: false }` restamps and queues it once, and the start after queues
/// nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_restamps_a_vault_bound_before_the_restamp_once() {
    const HOME: &str = "0b9e4c27-5f1a-4d83-a6e2-7c4d1f8b3a95";
    let mut server = Server::start();
    let store = device_key::with_device_key();
    let (_dir, account, _) = new_account(&mut server, store.clone(), super::account::EMAIL).await;
    let vault_dir = tempfile::tempdir().unwrap();
    let session = open_session(&vault_dir);
    let open = session.current().unwrap();
    let local = open.vault.id();
    let device = account.session().local_device_id().unwrap();
    let db = open.vault.db_handle();
    {
        let local = local.clone();
        db.call_blocking(move |conn| {
            let new = NewCanvas {
                id: Some("drawn"),
                title: Some("drawn"),
                owner_note_id: None,
                scene: None,
                folder: None,
                icon: None,
            };
            canvas::create(conn, &new, &local, &device, 1)?;
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
    }
    let binding = StoredBinding {
        user_id: account.session().account_user_id().unwrap(),
        mode: BindingMode::Sync,
    };
    write_binding(&open, session.registry(), &binding, Some(HOME)).unwrap();
    open.vault.bind_server_vault(HOME).unwrap();
    assert_eq!(stated(&db, "canvas", "drawn"), (local, 0));

    for (start, queued) in [("first start", 1), ("next start", 0)] {
        let applied = account
            .apply_open_vault_binding(&open, session.registry())
            .await
            .unwrap();
        assert_eq!(applied, Applied::Start, "{start}");
        assert_eq!(
            stated(&db, "canvas", "drawn"),
            (HOME.to_owned(), queued),
            "{start}"
        );
        db.call_blocking(|conn| {
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
    }
}
