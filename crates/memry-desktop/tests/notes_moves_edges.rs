//! The edges of a note's rename or move in the app (#3851, Step 13g-4 of #3530): a folder the
//! disk spells in another case, and a file that cannot go back after its record did not
//! follow it. The main flow is `notes_moves.rs`, whose helpers these tests share.

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;

use memry_core::domain::notes::app_move::{PendingMove, Recorded};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::moves::MoveTo;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use unicode_normalization::UnicodeNormalization;
use vault_env::indexed;

use crate::notes_moves::{
    file_note, names_in, note, note_count, opened, pending, record, row_facts,
};

/// A folder named in another case or Unicode form than one its parent holds is that folder,
/// on every volume: the note lands in it, and its record and row name the folder as the disk
/// spells it. A volume that folds them (APFS, NTFS) would put the file there anyway, and one
/// that does not (ext4) makes no second spelling that a device on the other kind receives.
#[test]
fn a_move_into_a_folder_spelled_another_way_takes_the_disk_s_spelling() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "")).unwrap();
    let decomposed: String = "Café".nfd().collect();
    fs::create_dir_all(e.vault.join("work").join(&decomposed)).unwrap();

    let moved = notes.move_to_folder(&open, &made.id, "WORK").unwrap();
    assert_eq!(moved.note.path, "work/Plan.md");
    assert_eq!(record(&e, &made.id).1.as_deref(), Some("work"));
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    let spellings = |folder: &str, of: &str| -> Vec<String> {
        let of = of.nfc().collect::<String>().to_lowercase();
        names_in(&e, folder)
            .into_iter()
            .filter(|name| name.nfc().collect::<String>().to_lowercase() == of)
            .collect()
    };
    assert_eq!(spellings("", "work"), ["work"]);

    let moved = notes
        .move_to_folder(&open, &made.id, "Work/Café/Q3")
        .unwrap();
    let folder = format!("work/{decomposed}/Q3");
    assert_eq!(moved.note.path, format!("{folder}/Plan.md"));
    assert_eq!(record(&e, &made.id).1, Some(folder.clone()));
    assert!(e.vault.join(&folder).join("Plan.md").is_file());
    assert_eq!(spellings("work", "café"), [decomposed]);

    // The note's own folder under another spelling moves nothing.
    let stayed = notes
        .move_to_folder(&open, &made.id, &folder.to_uppercase())
        .unwrap();
    assert_eq!(stayed.note.path, format!("{folder}/Plan.md"));
}

/// Moves the note's file `name` from `from` to `archive`, the record failing to follow it and
/// the file held so it cannot go back: on Unix `from` turns read-only, on Windows another
/// handle holds the moved file without `FILE_SHARE_DELETE`, as a program that has it open does
/// (a sharing violation, which the move back retries). `None` when this process writes a
/// read-only folder anyway (as root), and the test has nothing to show.
fn move_that_cannot_go_back(
    notes: &NotesService,
    open: &OpenVault,
    note_id: &str,
    from: &Path,
    name: &str,
) -> Option<NotesError> {
    let injected = || Err(NotesError::Io(std::io::Error::other("injected")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        let _ = name;
        let mode = |mode| fs::set_permissions(from, fs::Permissions::from_mode(mode)).unwrap();
        let probe = from.join(".probe");
        mode(0o555);
        let writable = fs::write(&probe, "").is_ok();
        mode(0o755);
        if writable {
            fs::remove_file(probe).unwrap();
            return None;
        }
        let failed = notes.move_checked(open, note_id, MoveTo::Folder("archive"), &mut || {
            mode(0o555);
            injected()
        });
        mode(0o755);
        failed.err()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;

        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        let moved = from.parent().unwrap().join("archive").join(name);
        let mut held = None;
        let failed = notes.move_checked(open, note_id, MoveTo::Folder("archive"), &mut || {
            let file = fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&moved)
                .unwrap();
            held = Some(file);
            injected()
        });
        drop(held);
        failed.err()
    }
}

/// A note whose record could not follow its file, and whose file could not go back (each try
/// refused for over half a second, as a lock or a permission refuses it), stays one note: the
/// old name's going and the new name's coming are the app's, so the watcher reports neither a
/// removal nor a new note, and the next open finishes the move from the record. A markdown
/// note and a file note alike, though no file note is adopted as new yet: the step that adopts
/// them must not take the record's new path for one.
#[test]
fn a_note_whose_file_cannot_go_back_stays_one_note_until_the_open_finishes_its_move() {
    let (mut e, notes, store) = opened();
    fs::create_dir_all(e.vault.join("work")).unwrap();
    let pdf = file_note(&mut e, &store, "work/scan.pdf", b"%PDF-1.4\n");
    let open = e.session.current().unwrap();
    let markdown = notes.create(&open, note("Plan", "work")).unwrap().id;
    e.drain();

    let work = e.vault.join("work");
    for (id, name) in [(&markdown, "Plan.md"), (&pdf, "scan.pdf")] {
        let Some(failed) = move_that_cannot_go_back(&notes, &open, id, &work, name) else {
            return;
        };
        assert!(matches!(failed, NotesError::Io(_)), "{failed:?}");
        assert!(e.vault.join("archive").join(name).is_file());
        assert!(!work.join(name).exists());
        let recorded = Recorded::Move(PendingMove {
            old_path: format!("work/{name}"),
            new_path: format!("archive/{name}"),
            title: None,
        });
        let pending_of_id: Vec<_> = pending(&e, &store)
            .into_iter()
            .filter(|(note_id, _)| note_id == id)
            .collect();
        assert_eq!(pending_of_id, [(id.clone(), recorded)]);
    }
    assert_eq!(
        row_facts(&mut e),
        [],
        "the watcher took the app's move for its own"
    );
    let rows = |paths: [&str; 2]| {
        let mut rows = vec![
            (markdown.clone(), paths[0].to_owned()),
            (pdf.clone(), paths[1].to_owned()),
        ];
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        rows
    };
    assert_eq!(e.rows(), rows(["work/Plan.md", "work/scan.pdf"]));

    drop(open);
    e.close();
    e.open();
    e.facts_until(indexed);
    assert_eq!(e.rows(), rows(["archive/Plan.md", "archive/scan.pdf"]));
    assert_eq!(pending(&e, &store), []);
    assert_eq!(note_count(&e), 2);
    assert!(!record(&e, &markdown).2 && !record(&e, &pdf).2);
}
