//! The twelve sync commands (`ipc/sync-core-handlers.ts`) through the IPC a renderer calls, on a
//! mock app over a real vault and session: each answers from the vault's tables, and the status,
//! Sync Now and pause commands answer from the supervisor the session runs, or as Electron
//! answers with no engine when none runs.

mod support;

use std::sync::Arc;

use memry_core::api::errors::SyncError;
use memry_core::crypto::sodium;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore, Store, StoreFactory};
use memry_desktop::session::Session;
use memry_desktop::sync::backend::{SyncBackend, SyncPasses};
use memry_desktop::sync::gate::{AuthFacts, Entitlement, SyncStartGate, VaultBinding};
use memry_desktop::sync::signals::AuthSignals;
use memry_desktop::sync::supervisor::{SupervisorParts, SyncSupervisor};
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

const NOTE: &str = "The body.\n";

struct Keychain(Store);

impl StoreFactory for Keychain {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

fn mocked(files: &[(&str, &str)]) -> Mocked {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::sync::sync_get_history::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_large_notes::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_note_sync_state::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_quarantined_items::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_queue_size::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_status::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_synced_settings::<MockRuntime>,
            memry_tauri::commands::sync::sync_get_unsent_notes::<MockRuntime>,
            memry_tauri::commands::sync::sync_pause::<MockRuntime>,
            memry_tauri::commands::sync::sync_resume::<MockRuntime>,
            memry_tauri::commands::sync::sync_trigger::<MockRuntime>,
            memry_tauri::commands::sync::sync_update_synced_setting::<MockRuntime>,
        ]);
    let mocked = Mocked::open(files, commands);
    let keychain = Keychain(keyring_core::mock::Store::new().unwrap());
    let keyring = Arc::new(KeyringStore::with_factory(keychain, None, WAIT));
    let store = Arc::new(DeviceIdentityStore::with_probe(
        &keyring,
        &mocked.vault,
        || false,
    ));
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    mocked.webview.manage(store);
    mocked
}

fn session(mocked: &Mocked) -> Session {
    mocked.session().inner().clone()
}

/// Runs `sql` on the open vault's `data.db` writer.
fn exec(mocked: &Mocked, sql: &'static str) {
    session(mocked)
        .current()
        .unwrap()
        .vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute_batch(sql).unwrap();
            Ok(())
        })
        .unwrap();
}

fn note_id(mocked: &Mocked, path: &str) -> String {
    session(mocked)
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path(path)
        .unwrap()
        .expect("a row for the note")
        .note_id
}

/// Signed in and keyed; every open fails, so no pass ever runs.
struct NoPasses;

#[async_trait::async_trait]
impl SyncBackend for NoPasses {
    async fn auth_facts(&self) -> AuthFacts {
        AuthFacts {
            signed_in: true,
            key_verified: true,
            recovery_confirmed: true,
            keychain_unavailable: false,
        }
    }
    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
        Err(SyncError::Locked)
    }
    fn refresh_refused(&self) -> bool {
        false
    }
    fn close(&self) {}
}

struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// Attaches a supervisor whose gate says start, and waits until the status says so.
fn attach(mocked: &Mocked) -> SyncSupervisor {
    let session = session(mocked);
    let runtime = tauri::async_runtime::handle().inner().clone();
    let factory = Arc::new(
        move |open: &memry_desktop::session::OpenVault, signals: &AuthSignals| {
            let gate = Arc::new(SyncStartGate::default());
            gate.set_binding(VaultBinding::Bound);
            gate.set_entitlement(Entitlement::Entitled);
            Some(SyncSupervisor::start(
                &runtime,
                SupervisorParts {
                    backend: Arc::new(NoPasses),
                    gate,
                    reachability: Arc::new(Online),
                    power: None,
                    keychain_recovered: None,
                    db: open.vault.db_handle(),
                    telemetry: None,
                    signals: signals.clone(),
                    on_status: Arc::new(|_| {}),
                },
            ))
        },
    );
    session.attach_sync(factory);
    let supervisor = session.sync_supervisor().expect("a supervisor runs");
    let deadline = std::time::Instant::now() + WAIT;
    while !supervisor.status().sync_eligible {
        assert!(
            std::time::Instant::now() < deadline,
            "the gate never opened"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    supervisor
}

#[test]
fn status_and_sync_now_answer_idle_and_unavailable_with_no_supervisor() {
    let mocked = mocked(&[]);
    assert_eq!(
        mocked.invoke("sync_get_status", json!({})).unwrap(),
        json!({"status": "idle", "pendingCount": 0})
    );
    assert_eq!(
        mocked.invoke("sync_trigger", json!({})).unwrap(),
        json!({
            "success": false,
            "reason": "unavailable",
            "error": "errors:sync.engineNotInitialized"
        })
    );
    let surface = json!({"input": {"surface": "popover"}});
    assert_eq!(
        mocked.invoke("sync_pause", surface.clone()).unwrap(),
        json!({"success": false, "wasPaused": false})
    );
    assert_eq!(
        mocked.invoke("sync_resume", surface).unwrap(),
        json!({"success": false, "pendingCount": 0})
    );
}

#[test]
fn pause_persists_shows_paused_and_resume_ends_it() {
    let mocked = mocked(&[]);
    let supervisor = attach(&mocked);
    let surface = json!({"input": {"surface": "settings"}});
    assert_eq!(
        mocked.invoke("sync_pause", surface.clone()).unwrap(),
        json!({"success": true, "wasPaused": false})
    );
    assert_eq!(
        mocked.invoke("sync_pause", surface.clone()).unwrap(),
        json!({"success": true, "wasPaused": true})
    );
    assert_eq!(
        mocked.invoke("sync_get_status", json!({})).unwrap()["status"],
        "paused"
    );
    let paused = |mocked: &Mocked| {
        session(mocked)
            .current()
            .unwrap()
            .vault
            .db_handle()
            .read_blocking(memry_core::sync::pause::read)
            .unwrap()
    };
    assert!(paused(&mocked), "the pause is in meta");
    exec(
        &mocked,
        "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('task', 't1', 'upsert', 1)",
    );
    assert_eq!(
        mocked.invoke("sync_resume", surface).unwrap(),
        json!({"success": true, "pendingCount": 1})
    );
    assert!(!paused(&mocked));
    assert_ne!(
        mocked.invoke("sync_get_status", json!({})).unwrap()["status"],
        "paused"
    );
    supervisor.stop_blocking();
}

#[test]
fn sync_now_with_a_supervisor_answers_from_it() {
    let mocked = mocked(&[]);
    let supervisor = attach(&mocked);
    let answer = mocked.invoke("sync_trigger", json!({})).unwrap();
    assert_eq!(answer["success"], false, "{answer}");
    assert_ne!(answer["reason"], "unavailable", "{answer}");
    supervisor.stop_blocking();
}

#[test]
fn history_pages_newest_first_and_parses_details() {
    let mocked = mocked(&[]);
    exec(
        &mocked,
        "INSERT INTO sync_history (id, kind, item_count, direction, details, duration_ms, created_at)
         VALUES ('a', 'push', 2, 'push', '{\"n\":1}', 5, 10),
                ('b', 'error', 0, NULL, 'not json', NULL, 20),
                ('c', 'pull', 3, 'pull', NULL, 7, 30)",
    );
    let page = mocked
        .invoke(
            "sync_get_history",
            json!({"input": {"limit": 2, "offset": 0}}),
        )
        .unwrap();
    assert_eq!(
        page,
        json!({
            "entries": [
                {"id": "c", "type": "pull", "itemCount": 3, "direction": "pull", "durationMs": 7, "createdAt": 30},
                {"id": "b", "type": "error", "itemCount": 0, "details": "not json", "createdAt": 20}
            ],
            "total": 3
        })
    );
    let rest = mocked
        .invoke("sync_get_history", json!({"input": {"offset": 2}}))
        .unwrap();
    assert_eq!(rest["entries"][0]["details"], json!({"n": 1}));
    let refused = mocked
        .invoke("sync_get_history", json!({"input": {"limit": 0}}))
        .unwrap_err();
    assert_eq!(refused["code"], "invalid_input");
}

#[test]
fn queue_size_counts_record_rows_never_tried_and_failed() {
    let mocked = mocked(&[]);
    exec(
        &mocked,
        "INSERT INTO outbox (item_type, item_id, op, enqueued_at, attempt_count) VALUES
           ('task', 't1', 'upsert', 1, 0),
           ('task', 't2', 'upsert', 1, 2),
           ('note', 'n1', 'crdt-update', 1, 0)",
    );
    assert_eq!(
        mocked.invoke("sync_get_queue_size", json!({})).unwrap(),
        json!({"pending": 1, "failed": 1})
    );
}

#[test]
fn quarantined_items_list_live_entries_only() {
    let mocked = mocked(&[]);
    let now = i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap();
    let sql: &'static str = Box::leak(
        format!(
            "INSERT INTO sync_quarantine
               (item_type, item_id, signer_device_id, failed_at, attempt_count, last_error)
             VALUES ('task', 'live', 'dev-b', {now}, 3, 'bad signature'),
                    ('task', 'old', 'dev-b', 1, 1, 'bad signature')"
        )
        .into_boxed_str(),
    );
    exec(&mocked, sql);
    assert_eq!(
        mocked
            .invoke("sync_get_quarantined_items", json!({}))
            .unwrap(),
        json!([{
            "itemId": "live",
            "itemType": "task",
            "signerDeviceId": "dev-b",
            "failedAt": now,
            "attemptCount": 3,
            "lastError": "bad signature",
            "permanent": true
        }])
    );
}

#[test]
fn unsent_notes_and_note_state_follow_the_queue_and_eligibility() {
    let mocked = mocked(&[("Plan.md", NOTE)]);
    let id = note_id(&mocked, "Plan.md");
    let sql: &'static str = Box::leak(
        format!(
            "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', '{id}', 'upsert', 42)"
        )
        .into_boxed_str(),
    );
    exec(&mocked, sql);
    let unsent = mocked.invoke("sync_get_unsent_notes", json!({})).unwrap();
    assert_eq!(unsent["total"], 1, "{unsent}");
    assert_eq!(unsent["notes"][0]["id"], json!(id));
    assert_eq!(unsent["notes"][0]["path"], "Plan.md");
    // The open queued the new note's body too.
    assert_eq!(unsent["notes"][0]["reasons"], json!(["body", "record"]));
    assert_eq!(unsent["notes"][0]["state"], "not_syncing");

    let input = json!({"input": {"noteId": id}});
    let state = mocked
        .invoke("sync_get_note_sync_state", input.clone())
        .unwrap();
    assert_eq!(state["state"], "not_syncing", "{state}");
    assert_eq!(state["waitingSince"], 42);

    let supervisor = attach(&mocked);
    let state = mocked.invoke("sync_get_note_sync_state", input).unwrap();
    assert_eq!(
        state["state"], "pending",
        "an eligible install waits on the queue"
    );
    supervisor.stop_blocking();

    assert_eq!(
        mocked
            .invoke(
                "sync_get_note_sync_state",
                json!({"input": {"noteId": "missing"}})
            )
            .unwrap(),
        Value::Null
    );
    let refused = mocked
        .invoke("sync_get_note_sync_state", json!({"input": {"noteId": ""}}))
        .unwrap_err();
    assert_eq!(refused["code"], "invalid_input");
}

#[test]
fn large_notes_measure_the_files_against_the_ceiling() {
    let big = "a".repeat(3_200_000);
    let mocked = mocked(&[("Small.md", NOTE), ("Big.md", big.as_str())]);
    let id = note_id(&mocked, "Big.md");
    let large = mocked.invoke("sync_get_large_notes", json!({})).unwrap();
    assert_eq!(large["maxBytes"], 3_826_919);
    assert_eq!(
        large["notes"],
        json!([{
            "id": id,
            "title": "Big",
            "path": "Big.md",
            "sizeBytes": 3_200_000,
            "status": "approaching"
        }])
    );
}

#[test]
fn a_synced_setting_write_is_read_back_and_queued() {
    let mocked = mocked(&[]);
    assert_eq!(
        mocked
            .invoke("sync_get_synced_settings", json!({}))
            .unwrap(),
        json!({})
    );
    assert_eq!(
        mocked
            .invoke(
                "sync_update_synced_setting",
                json!({"input": {"fieldPath": "general.theme", "value": "dark"}})
            )
            .unwrap(),
        json!({"success": true})
    );
    assert_eq!(
        mocked
            .invoke("sync_get_synced_settings", json!({}))
            .unwrap(),
        json!({"general": {"theme": "dark"}})
    );
    let queued = session(&mocked)
        .current()
        .unwrap()
        .vault
        .db_handle()
        .read_blocking(|conn| memry_core::sync::outbox::queued_for(conn, "synced_settings"))
        .unwrap();
    assert_eq!(queued, 1);
    let refused = mocked
        .invoke(
            "sync_update_synced_setting",
            json!({"input": {"fieldPath": "", "value": 1}}),
        )
        .unwrap_err();
    assert_eq!(refused["code"], "invalid_input");
}
