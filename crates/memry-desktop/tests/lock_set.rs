//! Locking and unlocking on this device (Step 14e-3, Electron `setVaultLock`,
//! `vault-locks/service.ts`) over a real session, tier, watcher, `data.db` and vault files:
//! - a lock makes the note's files read-only and records its text at once, and an unlock gives
//!   them back, without waiting for the next open;
//! - a lock records the text the note has now, never a baseline an earlier lock left: an outside
//!   edit is then reverted to that text, not rolled back to an older one;
//! - a folder unlocked frees the files an older build made read-only without a record, and
//!   leaves those another lock covers;
//! - a folder lock needs a folder on disk inside the vault.

use memry_desktop::locks::{Locks, TargetKind};
use memry_desktop::notes::error::NotesError;

use crate::lock_outside_edits::{edit_outside, until};
use crate::lock_service::{NOTE, guarded, read_only, unlock};
use crate::notes_link_rewrite::id_at;
use crate::vault_env::{Env, QUIET};

const EDITED: &str = "Edited while it was unlocked.\n";

fn baseline(e: &Env, id: &str) -> Option<String> {
    e.core().locks().baseline(id).unwrap().map(|b| b.content)
}

#[test]
fn a_lock_protects_the_note_at_once_and_an_unlock_frees_it() {
    let (e, _) = guarded(&[("Plan.md", NOTE), ("Free.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    let picture = format!("attachments/{plan}/a1b2c3-pic.png");
    e.write(&picture, "png bytes");
    let locks = Locks::of(&open);

    let set = locks.set(TargetKind::Note, &plan, true).unwrap();
    assert!(set.changed);
    assert_eq!(set.state.notes, std::slice::from_ref(&plan));
    assert!(read_only(&e, "Plan.md") && read_only(&e, &picture));
    assert!(!read_only(&e, "Free.md"));
    assert_eq!(baseline(&e, &plan).as_deref(), Some(NOTE));
    assert!(!locks.set(TargetKind::Note, &plan, true).unwrap().changed);

    let set = locks.set(TargetKind::Note, &plan, false).unwrap();
    assert!(set.changed && set.state.notes.is_empty());
    assert!(!read_only(&e, "Plan.md") && !read_only(&e, &picture));
    assert_eq!(baseline(&e, &plan), None);
}

/// The rollback of #4082's review: an unlock the reconcile did not follow (a remote one, a
/// crash) leaves the old baseline; the next lock must record the text the note has now.
#[test]
fn a_lock_records_the_text_the_note_has_now_and_an_outside_edit_goes_back_to_it() {
    let (e, _) = guarded(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    let locks = Locks::of(&open);
    locks.set(TargetKind::Note, &plan, true).unwrap();
    unlock(&e, TargetKind::Note, &plan);
    assert_eq!(
        baseline(&e, &plan).as_deref(),
        Some(NOTE),
        "a stale baseline"
    );
    edit_outside(&e, "Plan.md", EDITED);
    until("the edit reached the note", || {
        e.body(&plan) == EDITED.trim_end()
    });

    locks.set(TargetKind::Note, &plan, true).unwrap();
    assert_eq!(baseline(&e, &plan).as_deref(), Some(EDITED));
    edit_outside(&e, "Plan.md", "Written outside the app.\n");
    until("the locked text is back", || e.read("Plan.md") == EDITED);
    std::thread::sleep(QUIET);
    assert_eq!(e.read("Plan.md"), EDITED);
    assert_eq!(e.body(&plan), EDITED.trim_end());
}

#[test]
fn an_unlocked_folder_frees_what_an_older_build_left_read_only_but_not_another_locks() {
    let (e, _) = guarded(&[("Archive/Old.md", NOTE), ("Archive/Kept.md", NOTE)]);
    let open = e.session.current().unwrap();
    let kept = id_at(&e, "Archive/Kept.md");
    e.write("Archive/pic.png", "png bytes");
    let locks = Locks::of(&open);
    locks.set(TargetKind::Folder, "Archive", true).unwrap();
    locks.set(TargetKind::Note, &kept, true).unwrap();
    // Read-only with no record of its bits, as a build before the records left it.
    e.core()
        .locks()
        .forget_file_mode("Archive/pic.png")
        .unwrap();
    e.core().locks().forget_file_mode("Archive/Old.md").unwrap();
    assert!(read_only(&e, "Archive/pic.png") && read_only(&e, "Archive/Old.md"));

    let set = locks.set(TargetKind::Folder, "Archive/", false).unwrap();
    assert!(set.changed && set.state.folders.is_empty());
    assert!(!read_only(&e, "Archive/pic.png"));
    assert!(!read_only(&e, "Archive/Old.md"));
    assert!(read_only(&e, "Archive/Kept.md"), "its own lock still holds");
}

#[test]
fn a_folder_lock_needs_a_folder_on_disk_inside_the_vault() {
    let (e, _) = guarded(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    let locks = Locks::of(&open);

    for target in ["Missing", "", "/", "Archive/Old.md", "../outside"] {
        let refused = locks.set(TargetKind::Folder, target, true);
        assert!(
            matches!(
                refused,
                Err(NotesError::FolderNotFound | NotesError::Outside | NotesError::InvalidFolder)
            ),
            "{target}: {refused:?}"
        );
    }
    let missing = locks.set(TargetKind::Note, "no-such-note", true);
    assert!(
        matches!(missing, Err(NotesError::Storage(_))),
        "{missing:?}"
    );
    let state = e.core().locks().list().unwrap();
    assert!(state.notes.is_empty() && state.folders.is_empty());
}
