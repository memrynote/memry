//! Where a downloaded embed lands (#3535, Step 18 S7), against the real Worker: the eager
//! download of a reference ends at the name or the path the note body gives it, and is recorded
//! there.
//!
//! | Test                                                        | Electron                             |
//! | ----------------------------------------------------------- | ------------------------------------ |
//! | a download renamed in the body lands under the body's name   | `applyDownloadedAttachmentName`      |
//! | a download the body links outside the note folder moves there | `placeDownloadedFile` (#2755)       |
//! | a linked path that is taken keeps the download where it landed | `isFreeInsideVault`                |

use memry_core::domain::note_files::{self, NoteFileStat};

use super::service::{create_note, on, recorded, start, sync_of, until, wanted};
use super::{Device, MIB, Server, content};

/// Device `b` holds note `note-1` at `Pictures.md` with `body`; `a` uploaded `uploaded`.
/// Answers the attachment id, after `b` was asked to download it.
async fn download_into(
    server: &Server,
    b: &Device,
    uploaded: &str,
    body: &str,
) -> (String, Vec<u8>) {
    let a = Device::new(server, 0);
    let plain = content(MIB, 7);
    a.write(uploaded, &plain);
    let id = a.upload(uploaded, &[]).await.expect("the upload");

    create_note(b, "note-1").await;
    b.write("Pictures.md", body.as_bytes());
    b.db.call(|conn| {
        note_files::upsert_stats(
            conn,
            &[NoteFileStat {
                note_id: "note-1".into(),
                path: "Pictures.md".into(),
                file_type: "markdown".into(),
                mime_type: None,
                file_size: None,
                content_hash: None,
                file_hash: None,
                indexed_at: 1,
            }],
        )
    })
    .await
    .unwrap();
    (id, plain)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_renamed_in_the_body_lands_under_the_bodys_name() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    let (id, plain) = download_into(
        &server,
        &b,
        "attachments/note-1/abc123-old.bin",
        "![](attachments/note-1/abc123-new.bin)\n",
    )
    .await;
    let sync = sync_of(&b, &on());
    start(&b, &sync).await;
    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));

    let path = until(&b, "the download is recorded", recorded("note-1", id)).await;
    assert_eq!(path, "attachments/note-1/abc123-new.bin");
    assert!(std::fs::read(b.vault.join(&path)).unwrap() == plain);
    assert!(!b.vault.join("attachments/note-1/abc123-old.bin").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_the_body_links_outside_the_note_folder_moves_there() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    let (id, plain) = download_into(
        &server,
        &b,
        "attachments/note-1/report.zip",
        "![](sources/report.zip)\n",
    )
    .await;
    let sync = sync_of(&b, &on());
    start(&b, &sync).await;
    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));

    let path = until(&b, "the download is recorded", recorded("note-1", id)).await;
    assert_eq!(path, "sources/report.zip");
    assert!(std::fs::read(b.vault.join(&path)).unwrap() == plain);
    assert!(!b.vault.join("attachments/note-1/report.zip").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_linked_path_that_is_taken_keeps_the_download_where_it_landed() {
    let server = Server::start();
    let b = Device::new(&server, 1);
    let (id, plain) = download_into(
        &server,
        &b,
        "attachments/note-1/report.zip",
        "![](sources/report.zip)\n",
    )
    .await;
    b.write("sources/report.zip", b"another file, never replaced");
    let sync = sync_of(&b, &on());
    start(&b, &sync).await;
    sync.observer()
        .attachment_download_needed(&wanted("note-1", &id));

    let path = until(&b, "the download is recorded", recorded("note-1", id)).await;
    assert_eq!(path, "attachments/note-1/report.zip");
    assert!(std::fs::read(b.vault.join(&path)).unwrap() == plain);
    assert_eq!(
        std::fs::read(b.vault.join("sources/report.zip")).unwrap(),
        b"another file, never replaced"
    );
}
