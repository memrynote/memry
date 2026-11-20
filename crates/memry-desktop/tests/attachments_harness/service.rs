//! `memry_desktop::sync::attachments::AttachmentSync` (#3535, Step 18 S6) against the real
//! Worker: the drivers and the pull observer over a temp vault.
//!
//! | Test                                                              | Electron                         |
//! | ----------------------------------------------------------------- | -------------------------------- |
//! | a queued upload leaves at start, and a pulled reference lands      | `runtime.ts:892-921`, `onDownloadNeeded` |
//! | a download the server lacks is recorded `missing`                  | `markDownloadFailed`             |
//! | background downloads wait while auto-download is off              | `isAttachmentAutoDownloadEnabled` |
//! | an owner id that climbs out of the vault asks for nothing         | `getNoteAttachmentsDir`          |
//! | a revived note is recorded before the observer returns            | `onNoteRevived`                  |
//! | the re-drive purges a dead failure and lands a live one           | `redriveAttachmentDownloads`     |
//! | the release waits for a pass that caught up                       | `deletedAssetReleaseRunner`      |
//! | the release gate closes on a pause, offline, or a short pass      | `isCaughtUpWithServer`           |
//! | a pause through the driver keeps the release closed               | `isCaughtUpWithServer`           |
//! | offline upload rounds count nothing, the reconnect uploads        | `attachmentUploadRedriver`       |
//! | a revoked device re-drives no upload and counts no attempt        | `attachmentUploadRedriver`       |
//! | a device with no token re-drives no upload, counts no attempt     | `attachmentUploadRedriver`       |
//! | a transfer that cannot start leaves no live queue                 | `getOrCreateDownloadQueue`       |

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::auth::AuthState;
use memry_core::api::errors::{StorageError, SyncError};
use memry_core::domain::notes;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::SecureStoreKey;
use memry_core::sync::attachments::queue::absolute;
use memry_core::sync::attachments::release::record_deleted_note;
use memry_core::sync::attachments::revival;
use memry_core::sync::attachments::store::download_failures::{self, FailureReason};
use memry_core::sync::attachments::store::{files, releases, upload_queue};
use memry_core::sync::driver::AttachmentDownload;
use memry_core::sync::engine::PassReport;
use memry_core::sync::pull::PullReport;
use memry_core::sync::state::{PassTrigger, SyncState};
use memry_desktop::sync::attachments::AttachmentSync;
use memry_desktop::sync::attachments::vault_files::DesktopVaultFiles;
use memry_desktop::sync::backend::{SyncBackend, VaultSyncBackend};

use super::{Device, MIB, REL, Server, VAULT_ID, content, routes};

/// A network the test switches; the drivers hear each change. Online at first.
#[derive(Default)]
struct Network {
    offline: AtomicBool,
    observers: Mutex<Vec<Arc<dyn ReachabilityObserver>>>,
}

impl Network {
    fn set_online(&self, online: bool) {
        self.offline.store(!online, Ordering::SeqCst);
        let observers = self.observers.lock().unwrap().clone();
        for observer in observers {
            observer.on_change(self.current());
        }
    }
}

impl Reachability for Network {
    fn current(&self) -> Reachable {
        if self.offline.load(Ordering::SeqCst) {
            Reachable::Offline
        } else {
            Reachable::Wifi
        }
    }
    fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
        self.observers.lock().unwrap().push(observer);
    }
}

/// The device's drivers, with background downloads switched by `auto`.
fn sync_of(device: &Device, auto: &Arc<AtomicBool>) -> AttachmentSync {
    sync_on(device, auto, &Network::default())
}

fn sync_on(device: &Device, auto: &Arc<AtomicBool>, network: &Network) -> AttachmentSync {
    let auto = Arc::clone(auto);
    AttachmentSync::new(
        device.db.clone(),
        Arc::new(DesktopVaultFiles::new(device.vault.clone())),
        Arc::new(move || auto.load(Ordering::SeqCst)),
        network,
        tokio::runtime::Handle::current(),
    )
}

/// A pass that pulled to the feed head.
fn pulled() -> PassReport {
    PassReport {
        trigger: PassTrigger::Timer,
        transitions: vec![SyncState::Pulling, SyncState::Applying, SyncState::Idle],
        final_state: SyncState::Idle,
        pull: PullReport {
            pages: 1,
            ..PullReport::default()
        },
        parked: false,
        pushed: false,
        pushed_items: 0,
        push_ms: 0,
        pull_error: None,
        push_error: None,
    }
}

fn on() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

async fn start(device: &Device, sync: &AttachmentSync) {
    sync.start(
        device.transfer().await,
        &device.clock_id,
        Arc::clone(&device.session),
    );
}

async fn create_note(device: &Device, id: &'static str) {
    let clock = device.clock_id.clone();
    device
        .db
        .call(move |conn| {
            let note = notes::NewNote {
                id,
                title: "Pictures",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            };
            notes::create(conn, &note, &clock, 1)
        })
        .await
        .unwrap();
}

fn wanted(owner: &str, id: &str) -> AttachmentDownload {
    AttachmentDownload {
        owner_id: owner.into(),
        attachment_id: id.into(),
        hint: "note".into(),
        own_file: false,
    }
}

/// Polls `check` on the device's database until it holds (the drivers run on their own task).
async fn until<T: Send + 'static>(
    device: &Device,
    what: &str,
    check: impl Fn(&rusqlite::Connection) -> Option<T> + Send + Sync + Clone + 'static,
) -> T {
    for _ in 0..600 {
        let check = check.clone();
        if let Some(found) = device.db.call(move |conn| Ok(check(conn))).await.unwrap() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}

fn recorded(
    owner: &'static str,
    id: String,
) -> impl Fn(&rusqlite::Connection) -> Option<String> + Clone {
    move |conn| files::path_of(conn, owner, &id).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_upload_leaves_at_start_and_a_pulled_reference_lands() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(2 * MIB, 41);
    a.write(REL, &plain);
    create_note(&a, "note-1").await;
    let queued = absolute(&DesktopVaultFiles::new(a.vault.clone()), REL);
    let row = queued.clone();
    a.db.call(move |conn| upload_queue::enqueue(conn, "note-1", &row, 2))
        .await
        .unwrap();

    let sync_a = sync_of(&a, &on());
    start(&a, &sync_a).await;
    // `record_uploaded` writes the reference, then drops the row: both settle.
    let id = until(
        &a,
        "the reference is recorded and the row is gone",
        move |conn| {
            let pending = upload_queue::has_pending(conn, "note-1", &queued).unwrap();
            let id = notes::read_attachment_references(conn, "note-1")
                .unwrap()
                .pop();
            id.filter(|_| !pending)
        },
    )
    .await;

    create_note(&b, "note-1").await;
    let sync_b = sync_of(&b, &on());
    start(&b, &sync_b).await;
    sync_b
        .observer()
        .attachment_download_needed(&wanted("note-1", &id));
    let path = until(
        &b,
        "the download is recorded",
        recorded("note-1", id.clone()),
    )
    .await;
    assert_eq!(
        path, REL,
        "the file lands in the note's folder, recorded vault-relative"
    );
    assert!(std::fs::read(b.vault.join(REL)).unwrap() == plain);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_the_server_lacks_is_recorded_missing() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    create_note(&b, "note-1").await;
    let sync = sync_of(&b, &on());
    start(&b, &sync).await;

    sync.observer()
        .attachment_download_needed(&wanted("note-1", "never-uploaded"));

    let (reason, attempts, next): (String, i64, Option<i64>) =
        until(&b, "the failure is recorded", |conn| {
            conn.query_row(
                "SELECT reason, attempts, next_attempt_at FROM attachment_download_failures",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok()
        })
        .await;
    assert_eq!((reason.as_str(), attempts), ("missing", 1));
    assert!(next.is_some(), "a first 404 is retried a day later");
}

#[tokio::test(flavor = "multi_thread")]
async fn background_downloads_wait_while_auto_download_is_off() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    a.write(REL, &content(MIB, 43));
    let first = a.upload(REL, &[]).await.unwrap();
    a.write("attachments/note-2/other.bin", &content(MIB, 47));
    let second = a.upload("attachments/note-2/other.bin", &[]).await.unwrap();
    create_note(&b, "note-1").await;
    create_note(&b, "note-2").await;
    let auto = Arc::new(AtomicBool::new(false));
    let sync = sync_of(&b, &auto);
    start(&b, &sync).await;
    b.wire.clear();

    sync.observer()
        .attachment_download_needed(&wanted("note-1", &first));
    auto.store(true, Ordering::SeqCst);
    sync.observer()
        .attachment_download_needed(&wanted("note-2", &second));
    until(&b, "the second lands", recorded("note-2", second)).await;

    assert!(
        routes(&b.wire.sent())
            .iter()
            .all(|route| !route.contains(&first)),
        "nothing was asked for the first: {:?}",
        routes(&b.wire.sent())
    );
    assert!(!b.vault.join(REL).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revived_note_is_recorded_before_the_observer_returns() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    let sync = sync_of(&b, &on());

    sync.observer().note_revived("note-1");

    let revived = b.db.call(|conn| revival::revived(conn)).await.unwrap();
    assert_eq!(revived, ["note-1"], "durable with no driver running");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_redrive_purges_a_dead_failure_and_lands_a_live_one() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(MIB, 53);
    a.write(REL, &plain);
    let id = a.upload(REL, &[]).await.unwrap();
    create_note(&b, "note-1").await;
    let (clock, live) = (b.clock_id.clone(), id.clone());
    b.db.call(move |conn| {
        notes::add_attachment_reference(conn, "note-1", &live, &clock, 2)?;
        let long_ago = 1_000;
        download_failures::record_failure(
            conn,
            "note-1",
            &live,
            FailureReason::Transient,
            "blip",
            long_ago,
        )?;
        download_failures::record_failure(
            conn,
            "deleted-note",
            "x",
            FailureReason::Transient,
            "blip",
            long_ago,
        )?;
        download_failures::record_failure(
            conn,
            "note-1",
            "dropped-ref",
            FailureReason::Transient,
            "blip",
            long_ago,
        )
        .map(drop)
    })
    .await
    .unwrap();

    let sync = sync_of(&b, &on());
    start(&b, &sync).await;

    until(&b, "the live failure lands", recorded("note-1", id)).await;
    let left: i64 =
        b.db.call(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM attachment_download_failures",
                [],
                |row| row.get(0),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .await
        .unwrap();
    assert_eq!(
        left, 0,
        "the dead rows are purged and the landed one cleared"
    );
    assert!(std::fs::read(b.vault.join(REL)).unwrap() == plain);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_release_waits_for_a_pass_that_caught_up() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    a.write(REL, &content(MIB, 59));
    let id = a.upload(REL, &[]).await.unwrap();
    create_note(&a, "gone-note").await;
    let clock = a.clock_id.clone();
    a.db.call(move |conn| {
        notes::add_attachment_reference(conn, "gone-note", &id, &clock, 2)?;
        // Deleted long before the 30-day grace started.
        record_deleted_note(conn, "gone-note", 1_000)?;
        conn.execute(
            "UPDATE notes SET deleted_at = 1000 WHERE id = 'gone-note'",
            [],
        )
        .map(drop)
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .await
    .unwrap();
    let sync = sync_of(&a, &on());
    a.wire.clear();
    start(&a, &sync).await;
    // Time for the start round, which runs the release last.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        routes(&a.wire.sent())
            .iter()
            .all(|route| !route.contains("dereference")),
        "nothing is freed before a pass caught up"
    );
    assert!(
        !a.db
            .call(|conn| releases::due(conn, i64::MAX))
            .await
            .unwrap()
            .is_empty()
    );

    sync.heard(Some(&pulled()));

    until(&a, "the release settles", |conn| {
        releases::due(conn, i64::MAX)
            .unwrap()
            .is_empty()
            .then_some(())
    })
    .await;
    assert!(
        routes(&a.wire.sent())
            .iter()
            .any(|route| route.contains("dereference"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owner_id_that_climbs_out_of_the_vault_asks_for_nothing() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    a.write(REL, &content(MIB, 61));
    let id = a.upload(REL, &[]).await.unwrap();
    create_note(&b, "note-1").await;
    let sync = sync_of(&b, &on());
    start(&b, &sync).await;
    b.wire.clear();

    sync.observer()
        .attachment_download_needed(&wanted("../../escaped", &id));
    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));
    until(&b, "the safe one lands", recorded("note-1", id.clone())).await;

    let asked = routes(&b.wire.sent())
        .iter()
        .filter(|route| route.contains(&id) && route.contains("manifest"))
        .count();
    assert_eq!(asked, 1, "only note-1 asked: {:?}", routes(&b.wire.sent()));
    assert!(!b.vault.join("../escaped").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_release_gate_closes_on_a_pause_offline_or_a_short_pass() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let network = Network::default();
    let sync = sync_on(&a, &on(), &network);
    let caught_up = |sync: &AttachmentSync| sync.caught_up_with_server();

    assert!(!caught_up(&sync), "no pass heard yet");
    sync.heard(Some(&pulled()));
    assert!(caught_up(&sync), "caught up and online");

    sync.set_paused(true);
    assert!(!caught_up(&sync), "caught up, then paused");
    sync.set_paused(false);
    assert!(!caught_up(&sync), "a resume waits for the next pass");
    sync.heard(Some(&pulled()));
    assert!(caught_up(&sync));

    network.set_online(false);
    assert!(!caught_up(&sync), "caught up, then offline");
    network.set_online(true);
    assert!(!caught_up(&sync), "a reconnect waits for the next pass");

    let short: [(&str, PassReport); 4] = [
        (
            "a failed pull",
            PassReport {
                pull_error: Some(SyncError::Locked),
                ..pulled()
            },
        ),
        (
            "a pull with more pages",
            PassReport {
                pull: PullReport {
                    has_more: true,
                    ..pulled().pull
                },
                ..pulled()
            },
        ),
        (
            "a refused pull",
            PassReport {
                pull: PullReport {
                    refused: true,
                    ..pulled().pull
                },
                ..pulled()
            },
        ),
        (
            "an offline pass",
            PassReport {
                transitions: vec![SyncState::Offline],
                final_state: SyncState::Offline,
                pull: PullReport::default(),
                ..pulled()
            },
        ),
    ];
    for (what, pass) in short {
        sync.heard(Some(&pulled()));
        assert!(caught_up(&sync));
        sync.heard(Some(&pass));
        assert!(!caught_up(&sync), "caught up, then {what}");
    }
    sync.heard(Some(&pulled()));
    sync.heard(None);
    assert!(!caught_up(&sync), "caught up, then a skipped pass");
}

#[tokio::test(flavor = "multi_thread")]
async fn offline_upload_rounds_count_nothing_and_the_reconnect_uploads() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    a.write(REL, &content(MIB, 61));
    create_note(&a, "note-1").await;
    let queued = absolute(&DesktopVaultFiles::new(a.vault.clone()), REL);
    let row = queued.clone();
    a.db.call(move |conn| upload_queue::enqueue(conn, "note-1", &row, 2))
        .await
        .unwrap();
    let network = Network::default();
    network.set_online(false);
    let sync = sync_on(&a, &on(), &network);
    let transfer = a.transfer().await;
    a.wire.clear();
    sync.start(transfer, &a.clock_id, Arc::clone(&a.session));
    // Time for the start round, which runs the upload re-drive first.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rows =
        a.db.call(|conn| upload_queue::list_pending(conn, 10))
            .await
            .unwrap();
    assert_eq!(rows.len(), 1, "the row stays queued");
    assert_eq!(rows[0].attempts, 0, "an offline round counts no attempt");
    assert!(a.wire.sent().is_empty(), "nothing goes out offline");

    network.set_online(true);
    until(&a, "the reconnect round uploads the row", move |conn| {
        (!upload_queue::has_pending(conn, "note-1", &queued).unwrap()).then_some(())
    })
    .await;
}

/// A note deleted long before the 30-day grace started, whose release of `id` is due now.
async fn delete_long_ago(device: &Device, note: &'static str, id: String) {
    create_note(device, note).await;
    let clock = device.clock_id.clone();
    device
        .db
        .call(move |conn| {
            notes::add_attachment_reference(conn, note, &id, &clock, 2)?;
            record_deleted_note(conn, note, 1_000)?;
            conn.execute("UPDATE notes SET deleted_at = 1000 WHERE id = ?1", [note])
                .map(drop)
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pause_through_the_driver_keeps_the_release_closed() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let other = "attachments/note-2/other.bin";
    a.write(REL, &content(MIB, 71));
    let first = a.upload(REL, &[]).await.unwrap();
    a.write(other, &content(MIB, 73));
    let second = a.upload(other, &[]).await.unwrap();
    delete_long_ago(&a, "gone-1", first).await;
    a.core.bind_server_vault(VAULT_ID).unwrap();
    let network = Arc::new(Network::default());
    let sync = sync_on(&a, &on(), &network);
    let backend = VaultSyncBackend::new(
        Arc::clone(&a.core),
        Arc::clone(&a.session),
        Arc::clone(&a.store),
        network.clone(),
        Vec::new(),
        Arc::new(|| (true, true)),
    )
    .with_attachments(sync.clone());
    // The driver `open` returns is the one that tells the attachment drivers of every pause.
    let driver = backend.open(Vec::new()).await.unwrap();

    driver.run_pass(PassTrigger::Explicit).await;
    assert!(
        sync.caught_up_with_server(),
        "a real pass reached the feed head"
    );
    until(&a, "the first release settles once caught up", |conn| {
        releases::due(conn, i64::MAX)
            .unwrap()
            .is_empty()
            .then_some(())
    })
    .await;

    driver.pause();
    delete_long_ago(&a, "gone-2", second).await;
    a.wire.clear();
    // A paused driver skips its pass; one already in flight lands at the feed head after it.
    assert!(driver.run_pass(PassTrigger::Explicit).await.is_none());
    sync.heard(Some(&pulled()));
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        routes(&a.wire.sent())
            .iter()
            .all(|route| !route.contains("dereference")),
        "nothing is freed while paused: {:?}",
        routes(&a.wire.sent())
    );
    assert!(
        !a.db
            .call(|conn| releases::due(conn, i64::MAX))
            .await
            .unwrap()
            .is_empty(),
        "the second release stays queued"
    );
}

/// A queued upload of `REL` for a note, the one row a skipped re-drive round must leave alone.
async fn queued_upload(device: &Device) {
    device.write(REL, &content(MIB, 61));
    create_note(device, "note-1").await;
    let queued = absolute(&DesktopVaultFiles::new(device.vault.clone()), REL);
    device
        .db
        .call(move |conn| upload_queue::enqueue(conn, "note-1", &queued, 2))
        .await
        .unwrap();
}

/// After the start round (which runs the upload re-drive first): the row is queued, no attempt
/// counted, and nothing went out.
async fn assert_upload_round_skipped(device: &Device) {
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rows = device
        .db
        .call(|conn| upload_queue::list_pending(conn, 10))
        .await
        .unwrap();
    assert_eq!(rows.len(), 1, "the row stays queued");
    assert_eq!(rows[0].attempts, 0, "a skipped round counts no attempt");
    assert!(device.wire.sent().is_empty(), "nothing goes out");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_device_redrives_no_upload_and_counts_no_attempt() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    queued_upload(&a).await;
    let sync = sync_of(&a, &on());
    let transfer = a.transfer().await;
    // A restored session, then revoked: `note_device_revoked` keeps the token, as desktop does.
    // `mark_revoked` clears it, and the round would then skip for want of a token.
    a.store
        .set(SecureStoreKey::RefreshToken, b"refresh".to_vec())
        .unwrap();
    assert_eq!(a.session.restore().unwrap(), AuthState::Registered);
    assert_eq!(a.session.note_device_revoked().unwrap(), AuthState::Revoked);
    assert!(a.session.valid_access_token().await.unwrap().is_some());
    a.wire.clear();

    sync.start(transfer, &a.clock_id, Arc::clone(&a.session));

    assert_upload_round_skipped(&a).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_with_no_token_redrives_no_upload_and_counts_no_attempt() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    queued_upload(&a).await;
    let sync = sync_of(&a, &on());
    let transfer = a.transfer().await;
    a.store.delete(SecureStoreKey::AccessToken).unwrap();
    assert_eq!(a.session.valid_access_token().await.unwrap(), None);
    a.wire.clear();

    sync.start(transfer, &a.clock_id, Arc::clone(&a.session));

    assert_upload_round_skipped(&a).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_that_cannot_start_leaves_no_live_queue() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    a.write(REL, &content(MIB, 67));
    let id = a.upload(REL, &[]).await.unwrap();
    create_note(&b, "note-1").await;
    let sync = sync_of(&b, &on());
    // An earlier open started the drivers; this open's transfer failed.
    start(&b, &sync).await;
    sync.not_started(&"the master key is gone");
    b.wire.clear();

    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        routes(&b.wire.sent())
            .iter()
            .all(|route| !route.contains(&id)),
        "nothing downloads over the earlier open's transfer"
    );
    assert!(!b.vault.join(REL).exists());
}
