//! The chunked upload of an attachment (`memry_desktop::attachments::Uploads`, #3531 14f-2) on a
//! real vault: the parts wait in `.memry/uploads`, and the file reaches the note's attachments
//! folder whole after its last part, or nothing is left.
//!
//! | Test                                                              | Guard                          |
//! | ----------------------------------------------------------------- | ------------------------------ |
//! | a chunked upload lands whole, only after its last part            | the move after the last part   |
//! | a file over the cap is refused before anything is written         | 100 MiB at `begin`             |
//! | a part out of order, past the size or too big ends the upload     | offset, size and part checks   |
//! | a cancel, a closed page and a closed vault leave nothing          | `abort`, `release_owner`, close |
//! | uploads in flight are capped                                       | `MAX_UPLOADS`                  |
//! | what a crash left is deleted at the next open                     | the open sweep                 |
//! | an uploads folder linked out of the vault is neither used nor swept | `inside_vault`, the sweep's check |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_desktop::attachments::{
    AttachmentError, CHUNK_BYTES, MAX_FILE_SIZE, MAX_UPLOADS, Uploads,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use vault_env::{Env, env, indexed};

/// Bytes no two parts share, so a part written twice or out of place shows.
fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

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

fn parts(e: &Env) -> Vec<String> {
    names(&e.vault.join(".memry/uploads"))
}

fn attachments_of(e: &Env, note_id: &str) -> PathBuf {
    e.vault.join("attachments").join(note_id)
}

/// An open vault with `Plan.md` indexed, and uploads registered with its session.
fn open_vault() -> (Env, Arc<Uploads>, String) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    let uploads = Uploads::new();
    uploads.register(&e.session);
    e.write("notes/Plan.md", "Plan\n");
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let id = read::get_by_path(&open, "notes/Plan.md", None)
        .unwrap()
        .expect("indexed")
        .id;
    (e, uploads, id)
}

#[test]
fn a_chunked_upload_lands_whole_only_after_its_last_part() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let bytes = pattern(2 * CHUNK_BYTES + 5);
    let id = uploads
        .begin(&open, "main", &note, "Big clip.mp4", bytes.len() as u64)
        .unwrap();
    let mut saved = None;
    for (index, part) in bytes.chunks(CHUNK_BYTES).enumerate() {
        assert_eq!(names(&attachments_of(&e, &note)), Vec::<String>::new());
        assert_eq!(parts(&e).len(), 1);
        let offset = (index * CHUNK_BYTES) as u64;
        saved = uploads.write_chunk(&open, &id, offset, part).unwrap();
        assert_eq!(saved.is_some(), index == 2, "part {index}");
    }
    let saved = saved.unwrap();
    let stored = saved.path.rsplit('/').next().unwrap().to_owned();
    assert!(stored.ends_with("-Big-clip.mp4"), "{stored}");
    assert_eq!(saved.path, format!("../attachments/{note}/{stored}"));
    assert_eq!(saved.size, bytes.len());
    assert_eq!(saved.mime_type, "video/mp4");
    assert_eq!(names(&attachments_of(&e, &note)), vec![stored]);
    assert!(fs::read(&saved.disk_path).unwrap() == bytes);
    assert_eq!(parts(&e), Vec::<String>::new());
    // The upload is over: a part more finds nothing.
    assert!(matches!(
        uploads.write_chunk(&open, &id, bytes.len() as u64, b""),
        Err(AttachmentError::UploadGone)
    ));
}

#[test]
fn a_file_over_the_cap_is_refused_before_anything_is_written() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let over = MAX_FILE_SIZE as u64 + 1;
    let refused = uploads.begin(&open, "main", &note, "big.pdf", over);
    assert!(
        matches!(refused, Err(AttachmentError::TooLarge { size, limit })
            if size as u64 == over && limit == MAX_FILE_SIZE),
        "{refused:?}"
    );
    assert!(matches!(
        uploads.begin(&open, "main", &note, "tool.exe", 1),
        Err(AttachmentError::UnsupportedType(_))
    ));
    assert!(matches!(
        uploads.begin(&open, "main", "../x", "a.pdf", 1),
        Err(AttachmentError::InvalidNote)
    ));
    assert!(!e.vault.join(".memry/uploads").exists());
    assert!(!attachments_of(&e, &note).exists());
    // The cap itself is taken.
    assert!(
        uploads
            .begin(&open, "main", &note, "a.pdf", MAX_FILE_SIZE as u64)
            .is_ok()
    );
}

#[test]
fn a_part_out_of_order_past_the_size_or_too_big_ends_the_upload_with_nothing() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let refusals: [(u64, u64, Vec<u8>); 3] = [
        // A part that skips bytes.
        (10, 1, vec![0; 4]),
        // A part that runs past the declared size.
        (10, 0, vec![0; 11]),
        // A part over the part size, in order and within the file.
        (2 * CHUNK_BYTES as u64, 0, pattern(CHUNK_BYTES + 1)),
    ];
    for (size, offset, part) in refusals {
        let id = uploads.begin(&open, "main", &note, "a.pdf", size).unwrap();
        let refused = uploads.write_chunk(&open, &id, offset, &part);
        assert!(
            matches!(refused, Err(AttachmentError::BadChunk)),
            "{offset}: {refused:?}"
        );
        assert_eq!(parts(&e), Vec::<String>::new(), "{offset}");
        assert!(matches!(
            uploads.write_chunk(&open, &id, offset, b"x"),
            Err(AttachmentError::UploadGone)
        ));
    }
    assert_eq!(names(&attachments_of(&e, &note)), Vec::<String>::new());
}

#[test]
fn a_cancel_a_closed_page_and_a_closed_vault_leave_nothing() {
    let (mut e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let size = 2 * CHUNK_BYTES as u64;
    let begin = |owner: &str| {
        let id = uploads.begin(&open, owner, &note, "a.pdf", size).unwrap();
        let part = pattern(CHUNK_BYTES);
        assert!(uploads.write_chunk(&open, &id, 0, &part).unwrap().is_none());
        id
    };
    let cancelled = begin("main");
    let reloaded = [begin("note-window-1"), begin("note-window-1")];
    let other = begin("main");
    assert_eq!(parts(&e).len(), 4);

    uploads.abort(&cancelled);
    assert_eq!(parts(&e).len(), 3);
    uploads.release_owner("note-window-1");
    assert_eq!(parts(&e), vec![format!("{other}.part")]);
    e.close();
    assert_eq!(parts(&e), Vec::<String>::new());

    let rest = pattern(CHUNK_BYTES);
    for id in [&cancelled, &reloaded[0], &reloaded[1], &other] {
        assert!(matches!(
            uploads.write_chunk(&open, id, CHUNK_BYTES as u64, &rest),
            Err(AttachmentError::UploadGone)
        ));
    }
    assert_eq!(names(&attachments_of(&e, &note)), Vec::<String>::new());
}

#[test]
fn uploads_in_flight_are_capped() {
    let (e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    let ids: Vec<String> = (0..MAX_UPLOADS)
        .map(|_| uploads.begin(&open, "main", &note, "a.pdf", 1).unwrap())
        .collect();
    assert!(matches!(
        uploads.begin(&open, "main", &note, "a.pdf", 1),
        Err(AttachmentError::TooManyUploads)
    ));
    uploads.abort(&ids[0]);
    assert!(uploads.begin(&open, "main", &note, "a.pdf", 1).is_ok());
    assert_eq!(parts(&e).len(), MAX_UPLOADS);
}

/// The app dies mid-upload: its part file stays, nothing reached the attachments folder, and
/// the next open of the vault deletes the part before any upload can begin.
#[test]
fn what_a_crash_left_is_deleted_at_the_next_open() {
    let (mut e, uploads, note) = open_vault();
    let open = e.session.current().unwrap();
    // Uploads the session never ends: the process that held them is gone.
    let crashed = Uploads::new();
    let id = crashed
        .begin(&open, "main", &note, "a.pdf", 2 * CHUNK_BYTES as u64)
        .unwrap();
    let part = pattern(CHUNK_BYTES);
    assert!(crashed.write_chunk(&open, &id, 0, &part).unwrap().is_none());
    drop(crashed);
    drop(open);
    e.close();
    fs::write(e.vault.join(".memry/uploads/older.part"), b"x").unwrap();
    assert_eq!(parts(&e).len(), 2);
    assert_eq!(names(&attachments_of(&e, &note)), Vec::<String>::new());

    e.open();
    assert_eq!(parts(&e), Vec::<String>::new());
    let open = e.session.current().unwrap();
    assert!(uploads.begin(&open, "main", &note, "a.pdf", 1).is_ok());
}

#[cfg(unix)]
#[test]
fn an_uploads_folder_linked_out_of_the_vault_is_neither_used_nor_swept() {
    use std::os::unix::fs::symlink;

    let (mut e, uploads, note) = open_vault();
    let outside = e.vault.parent().unwrap().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep.part"), b"theirs").unwrap();
    symlink(&outside, e.vault.join(".memry/uploads")).unwrap();
    let open = e.session.current().unwrap();
    let refused = uploads.begin(&open, "main", &note, "a.pdf", 1);
    assert!(
        matches!(refused, Err(AttachmentError::NotAFolder)),
        "{refused:?}"
    );
    drop(open);
    e.close();
    e.open();
    assert_eq!(names(&outside), vec!["keep.part".to_owned()]);
}
