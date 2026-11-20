//! What the attachment drivers tell the renderer (#3535, Step 18 S7b), against the real Worker,
//! with Electron's events (`sync-attachment-handlers.ts:630,703,743`).
//!
//! | Test                                                   | Electron                                  |
//! | ------------------------------------------------------ | ----------------------------------------- |
//! | a landed download tells its note                       | `ATTACHMENT_MATERIALIZED { noteId }`      |
//! | a failed download tells its note and where it was going | `ATTACHMENT_UPLOAD_FAILED` (download side) |
//! | an upload that can never go tells its note and file    | `ATTACHMENT_UPLOAD_FAILED`                |

use std::sync::{Arc, Mutex};

use memry_core::sync::attachments::queue::absolute;
use memry_core::sync::attachments::store::upload_queue;
use memry_desktop::sync::attachments::vault_files::DesktopVaultFiles;
use memry_desktop::sync::events::SyncEvent;

use super::service::{create_note, recorded, start, sync_told, until, wanted};
use super::{Device, MIB, REL, Server, content};

type Told = Arc<Mutex<Vec<SyncEvent>>>;

fn listener() -> (Told, Arc<dyn Fn(&SyncEvent) + Send + Sync>) {
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

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_that_can_never_go_tells_its_note_and_file() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    create_note(&a, "note-1").await;
    // Queued, then the file left the disk: the drain drops the row.
    let queued = absolute(&DesktopVaultFiles::new(a.vault.clone()), REL);
    let row = queued.clone();
    a.db.call(move |conn| upload_queue::enqueue(conn, "note-1", &row, 2))
        .await
        .unwrap();
    let (told, on_event) = listener();
    let sync = sync_told(&a, on_event);
    start(&a, &sync).await;

    let (note, path) = heard(&told, |event| match event {
        SyncEvent::AttachmentFailed {
            note_id, disk_path, ..
        } => Some((note_id.clone(), disk_path.clone())),
        _ => None,
    })
    .await;
    assert_eq!((note.as_str(), path), ("note-1", queued));
}
