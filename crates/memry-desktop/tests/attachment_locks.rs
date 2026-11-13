//! A locked note's attachments refuse every write (`attachments::writable_note`, #3531 14f-2b),
//! as Electron's `saveAttachment` (`attachments.ts:427`) and `renameAttachment` do, on a real
//! vault with real lock rows. The note is locked by its own lock or by a locked folder above its
//! file: `attachments/<noteId>/` sits outside the note's folder, so the folder lock reaches it
//! only through the note's path.
//!
//! | Test                                                               | Guard                     |
//! | ------------------------------------------------------------------ | ------------------------- |
//! | an upload to a locked note writes nothing                          | `upload`                  |
//! | a chunked upload to a locked note never starts                     | `Uploads::begin`          |
//! | a lock set while the parts arrive ends the upload with nothing     | the chunk commit          |
//! | a rename of a locked note's attachment leaves the file             | `rename`                  |
//! | unlocked again, every write goes through                           | the lock, not the note    |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::attachments::{self, AttachmentError, CHUNK_BYTES, Uploads};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use vault_env::{Env, env, indexed};

fn names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// An open vault with `work/Plan.md` indexed and uploads registered; the note's id.
fn open_vault() -> (Env, std::sync::Arc<Uploads>, String) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    let uploads = Uploads::new();
    uploads.register(&e.session);
    e.write("work/Plan.md", "Plan\n");
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let id = read::get_by_path(&open, "work/Plan.md", None)
        .unwrap()
        .expect("indexed")
        .id;
    (e, uploads, id)
}

fn is_locked<T: std::fmt::Debug>(outcome: Result<T, AttachmentError>) -> bool {
    let locked = matches!(outcome, Err(AttachmentError::Locked));
    assert!(locked, "{outcome:?}");
    locked
}

#[test]
fn an_upload_to_a_locked_note_writes_nothing() {
    let (e, _uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let folder = e.vault.join("attachments").join(&note);
    for (kind, target) in [
        (TargetKind::Note, note.as_str()),
        (TargetKind::Folder, "work"),
    ] {
        open.vault
            .locks()
            .set(kind, target, true, "device-a")
            .unwrap();
        assert!(is_locked(attachments::upload(&open, &note, "a.png", b"x")));
        assert_eq!(
            AttachmentError::Locked.to_string(),
            "The owner made this note read-only."
        );
        assert_eq!(names(&folder), Vec::<String>::new(), "{target}");
        open.vault
            .locks()
            .set(kind, target, false, "device-a")
            .unwrap();
    }
    // Unlocked, the same upload lands.
    let saved = attachments::upload(&open, &note, "a.png", b"x").unwrap();
    assert!(saved.disk_path.is_file());
}

#[test]
fn a_chunked_upload_to_a_locked_note_never_starts() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    open.vault
        .locks()
        .set(TargetKind::Folder, "work", true, "device-a")
        .unwrap();
    let size = (2 * CHUNK_BYTES) as u64;
    assert!(is_locked(
        uploads.begin(&open, "main", &note, "clip.mp4", size)
    ));
    assert_eq!(names(&e.vault.join(".memry/uploads")), Vec::<String>::new());
    open.vault
        .locks()
        .set(TargetKind::Folder, "work", false, "device-a")
        .unwrap();
    assert!(
        uploads
            .begin(&open, "main", &note, "clip.mp4", size)
            .is_ok()
    );
}

#[test]
fn a_lock_set_while_the_parts_arrive_ends_the_upload_with_nothing() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let bytes = vec![7_u8; CHUNK_BYTES + 3];
    let id = uploads
        .begin(&open, "main", &note, "clip.mp4", bytes.len() as u64)
        .unwrap();
    assert_eq!(
        uploads
            .write_chunk(&open, &id, 0, &bytes[..CHUNK_BYTES])
            .unwrap(),
        None
    );
    open.vault
        .locks()
        .set(TargetKind::Note, &note, true, "device-a")
        .unwrap();
    assert!(is_locked(uploads.write_chunk(
        &open,
        &id,
        CHUNK_BYTES as u64,
        &bytes[CHUNK_BYTES..]
    )));
    assert_eq!(
        names(&e.vault.join("attachments").join(&note)),
        Vec::<String>::new()
    );
    assert_eq!(names(&e.vault.join(".memry/uploads")), Vec::<String>::new());
}

#[test]
fn a_rename_of_a_locked_notes_attachment_leaves_the_file() {
    let (e, _uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let saved = attachments::upload(&open, &note, "scan.pdf", b"%PDF").unwrap();
    let stored = saved
        .disk_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for (kind, target) in [
        (TargetKind::Note, note.as_str()),
        (TargetKind::Folder, "work"),
    ] {
        open.vault
            .locks()
            .set(kind, target, true, "device-a")
            .unwrap();
        assert!(is_locked(attachments::rename(
            &open,
            &note,
            &saved.path,
            "invoice"
        )));
        assert_eq!(
            names(&e.vault.join("attachments").join(&note)),
            std::slice::from_ref(&stored)
        );
        open.vault
            .locks()
            .set(kind, target, false, "device-a")
            .unwrap();
    }
    let renamed = attachments::rename(&open, &note, &saved.path, "invoice").unwrap();
    assert_eq!(&renamed.stored_filename[..7], &stored[..7]);
    assert!(renamed.stored_filename.ends_with("-invoice.pdf"));
}
