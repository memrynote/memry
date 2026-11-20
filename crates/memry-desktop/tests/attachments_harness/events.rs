//! What the attachment drivers tell the renderer (#3535, Step 18 S7b), against the real Worker,
//! with Electron's events (`sync-attachment-handlers.ts:630,703,743`).
//!
//! | Test                                                   | Electron                                  |
//! | ------------------------------------------------------ | ----------------------------------------- |
//! | a landed download tells its note                       | `ATTACHMENT_MATERIALIZED { noteId }`      |
//! | a failed download tells its note and where it was going | `ATTACHMENT_UPLOAD_FAILED` (download side) |
//! | a deleted file is dropped without telling              | nothing (`attachment-outbox.ts:218-238`)  |
//! | a file over the size cap tells its note and file       | `ATTACHMENT_UPLOAD_FAILED`                |
//! | a file over the plan is told on its first failure      | `ATTACHMENT_UPLOAD_FAILED`, `file_too_large` |

use std::sync::{Arc, Mutex};

use memry_core::sync::attachments::queue::absolute;
use memry_core::sync::attachments::store::upload_queue;
use memry_core::sync::attachments::upload::MAX_ATTACHMENT_SIZE;
use memry_desktop::sync::attachments::AttachmentSync;
use memry_desktop::sync::attachments::vault_files::DesktopVaultFiles;
use memry_desktop::sync::error_category::SyncErrorCategory;
use memry_desktop::sync::events::{OnSyncEvent, SyncEvent};

use super::service::{create_note, recorded, start, sync_told, until, wanted};
use super::{Device, MIB, REL, Server, content};

type Told = Arc<Mutex<Vec<SyncEvent>>>;

fn listener() -> (Told, OnSyncEvent) {
    let told: Told = Arc::default();
    let sink = Arc::clone(&told);
    (
        told,
        Arc::new(move |event| sink.lock().unwrap().push(event.clone())),
    )
}

/// Waits until `told` holds an event `pick` takes.
async fn heard<T>(told: &Told, pick: impl Fn(&SyncEvent) -> Option<T>) -> T {
    for _ in 0..600 {
        if let Some(found) = told.lock().unwrap().iter().find_map(&pick) {
            return found;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("never told: {:?}", told.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_landed_download_tells_its_note() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    a.write(REL, &content(MIB, 3));
    let id = a.upload(REL, &[]).await.expect("the upload");
    create_note(&b, "note-1").await;
    let (told, on_event) = listener();
    let sync = sync_told(&b, on_event);
    start(&b, &sync).await;

    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));

    until(&b, "the download is recorded", recorded("note-1", id)).await;
    let note = heard(&told, |event| match event {
        SyncEvent::AttachmentMaterialized { note_id } => Some(note_id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(note, "note-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_download_tells_its_note_and_where_it_was_going() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    create_note(&b, "note-1").await;
    let (told, on_event) = listener();
    let sync = sync_told(&b, on_event);
    start(&b, &sync).await;

    sync.observer()
        .attachment_download_needed(&wanted("note-1", "never-uploaded"));

    let (note, path, error) = heard(&told, |event| match event {
        SyncEvent::AttachmentFailed {
            note_id,
            disk_path,
            error,
            category: None,
        } => Some((note_id.clone(), disk_path.clone(), error.clone())),
        _ => None,
    })
    .await;
    assert_eq!(note, "note-1");
    assert!(path.ends_with("note-1"), "{path}");
    assert!(!error.is_empty());
    assert!(
        !told
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, SyncEvent::AttachmentMaterialized { .. }))
    );
}

/// Queues `REL` for upload on `a` and starts its drivers, telling `told`.
async fn queue_and_start(a: &Device) -> (AttachmentSync, Told, String) {
    create_note(a, "note-1").await;
    let queued = absolute(&DesktopVaultFiles::new(a.vault.clone()), REL);
    let row = queued.clone();
    a.db.call(move |conn| upload_queue::enqueue(conn, "note-1", &row, 2))
        .await
        .unwrap();
    let (told, on_event) = listener();
    let sync = sync_told(a, on_event);
    start(a, &sync).await;
    (sync, told, queued)
}

fn failures(told: &Told) -> Vec<(String, String, Option<SyncErrorCategory>)> {
    told.lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            SyncEvent::AttachmentFailed {
                note_id,
                disk_path,
                category,
                ..
            } => Some((note_id.clone(), disk_path.clone(), *category)),
            _ => None,
        })
        .collect()
}

/// Electron drops the upload of a deleted file silently (`attachment-outbox.ts:218-238`).
#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_file_is_dropped_without_telling() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    // Queued, then the file left the disk: the drain drops the row.
    let (_sync, told, _) = queue_and_start(&a).await;

    until(&a, "the row is dropped", |conn| {
        upload_queue::list_due(conn, i64::MAX)
            .unwrap()
            .is_empty()
            .then_some(())
    })
    .await;
    assert_eq!(failures(&told), []);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_the_size_cap_tells_its_note_and_file() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let file = a.write(REL, b"");
    std::fs::OpenOptions::new()
        .write(true)
        .open(file)
        .unwrap()
        .set_len(MAX_ATTACHMENT_SIZE + 1)
        .unwrap();
    let (_sync, told, queued) = queue_and_start(&a).await;

    heard(&told, |event| {
        matches!(event, SyncEvent::AttachmentFailed { .. }).then_some(())
    })
    .await;
    assert_eq!(failures(&told), [("note-1".to_owned(), queued, None)]);
}

/// The server's plan limit is told on the first failure, with `file_too_large` so the renderer
/// says `sync.fileTooLarge` (`sync-context.tsx:409`), and the row stays queued.
#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_the_plan_is_told_on_its_first_failure() {
    let mut server = Server::start();
    server.file_limit(MIB as u64);
    let a = Device::new(&server, 0);
    a.write(REL, &content(2 * MIB, 5));
    let (_sync, told, queued) = queue_and_start(&a).await;

    heard(&told, |event| {
        matches!(event, SyncEvent::AttachmentFailed { .. }).then_some(())
    })
    .await;
    assert_eq!(
        failures(&told),
        [(
            "note-1".to_owned(),
            queued,
            Some(SyncErrorCategory::FileTooLarge)
        )]
    );
    let attempts =
        a.db.call(|conn| upload_queue::list_due(conn, i64::MAX))
            .await
            .unwrap();
    assert_eq!(
        attempts.iter().map(|row| row.attempts).collect::<Vec<_>>(),
        [1]
    );
}
