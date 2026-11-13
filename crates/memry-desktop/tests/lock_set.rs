//! Locking and unlocking on this device (Step 14e-3, Electron `setVaultLock`,
//! `vault-locks/service.ts`) over a real session, tier, watcher, `data.db` and vault files:
//! - a lock makes the note's files read-only and records its text at once, and an unlock gives
//!   them back, without waiting for the next open;
//! - a lock records the text the note has now, never a baseline an earlier lock left: an outside
//!   edit is then reverted to that text, not rolled back to an older one;
//! - a folder unlocked frees the files an older build made read-only without a record, and
//!   leaves those another lock covers;
//! - a folder lock needs a folder on disk inside the vault, and names it as the disk spells it;
//! - an unlock lifts the lock row as it is spelled, whatever the disk spells now, and a name no
//!   lock has is refused.

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::locks::{self, LockSet, TargetKind};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;

use crate::lock_outside_edits::{edit_outside, until};
use crate::lock_service::{NOTE, guarded, read_only, unlock};
use crate::notes_link_rewrite::id_at;
use crate::vault_env::{Env, QUIET};

const EDITED: &str = "Edited while it was unlocked.\n";

fn baseline(e: &Env, id: &str) -> Option<String> {
    e.core().locks().baseline(id).unwrap().map(|b| b.content)
}

/// The app's lock change ([`locks::set`]) on the open vault.
struct Setter {
    open: OpenVault,
    notes: Arc<NotesService>,
}

impl Setter {
    fn new(e: &Env, store: Arc<dyn SecureStore>) -> Self {
        Self {
            open: e.session.current().unwrap(),
            notes: NotesService::new(e.tier.clone(), store),
        }
    }

    fn set(&self, kind: TargetKind, target: &str, locked: bool) -> Result<LockSet, NotesError> {
        locks::set(&self.open, &self.notes, kind, target, locked, || {})
    }
}

#[test]
fn a_lock_protects_the_note_at_once_and_an_unlock_frees_it() {
    let (e, store) = guarded(&[("Plan.md", NOTE), ("Free.md", NOTE)]);
    let plan = id_at(&e, "Plan.md");
    let picture = format!("attachments/{plan}/a1b2c3-pic.png");
    e.write(&picture, "png bytes");
    let locks = Setter::new(&e, store);

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
    let (e, store) = guarded(&[("Plan.md", NOTE)]);
    let plan = id_at(&e, "Plan.md");
    let locks = Setter::new(&e, store);
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
    let (e, store) = guarded(&[("Archive/Old.md", NOTE), ("Archive/Kept.md", NOTE)]);
    let kept = id_at(&e, "Archive/Kept.md");
    e.write("Archive/pic.png", "png bytes");
    let locks = Setter::new(&e, store);
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
    let (e, store) = guarded(&[("Archive/Old.md", NOTE)]);
    let locks = Setter::new(&e, store);

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

/// #4089's rule: the lock names the folder as the disk spells it. Stored as typed (`archive`
/// over `Archive/`, or `Café` in the other Unicode form), no note check would match it while
/// its files are read-only, and an outside edit of one would be fed past the lock.
#[test]
fn a_folder_lock_names_the_folder_as_the_disk_spells_it() {
    let nfc = "Caf\u{e9}";
    let nfd = "Cafe\u{301}";
    let (e, store) = guarded(&[("Archive/Plan.md", NOTE), (&format!("{nfc}/Menu.md"), NOTE)]);
    let locks = Setter::new(&e, store);
    let plan = id_at(&e, "Archive/Plan.md");
    let menu = id_at(&e, &format!("{nfc}/Menu.md"));
    let case_blind = e.vault.join("ARCHIVE").is_dir();

    // Every volume: the folder the disk holds in another Unicode form is that folder.
    let set = locks.set(TargetKind::Folder, nfd, true).unwrap();
    assert_eq!(set.state.folders, [nfc]);
    assert!(e.core().locks().is_note_locked(&menu, None).unwrap());
    assert!(read_only(&e, &format!("{nfc}/Menu.md")));
    let set = locks.set(TargetKind::Folder, nfd, false).unwrap();
    assert!(set.changed && set.state.folders.is_empty());
    assert!(!read_only(&e, &format!("{nfc}/Menu.md")));

    if case_blind {
        let set = locks.set(TargetKind::Folder, "archive", true).unwrap();
        assert_eq!(set.state.folders, ["Archive"]);
        assert!(e.core().locks().is_note_locked(&plan, None).unwrap());
    }
}

/// An unlock names the lock row, not the disk: a row another build or device wrote as `archive`
/// over the disk's `Archive/` is lifted by `archive`, and by any case or Unicode form of it.
/// Respelled as the disk spells it, the unlock found no row and quietly changed nothing, and
/// the folder stayed locked for good. A name no lock has is refused.
#[test]
fn an_unlock_lifts_the_lock_row_as_it_is_spelled() {
    let nfc = "Caf\u{e9}";
    let nfd = "Cafe\u{301}";
    let (e, store) = guarded(&[("Archive/Plan.md", NOTE), (&format!("{nfc}/Menu.md"), NOTE)]);
    let locks = Setter::new(&e, store);
    let rows = e.core().locks();

    for (row, given) in [("archive", "archive"), ("archive", "ARCHIVE"), (nfd, nfc)] {
        rows.set(TargetKind::Folder, row, true, "device-a").unwrap();
        let set = locks.set(TargetKind::Folder, given, false).unwrap();
        assert!(
            set.changed && set.state.folders.is_empty(),
            "{row} by {given}: {set:?}"
        );
    }
    for given in ["Archive", "Missing"] {
        let refused = locks.set(TargetKind::Folder, given, false);
        assert!(
            matches!(refused, Err(NotesError::FolderNotFound)),
            "{given}: {refused:?}"
        );
    }
}

/// A locked folder renamed in case outside the app, on a case-blind volume: the unlock by the
/// name it was locked under lifts the lock and frees its files under the new name.
#[test]
fn a_folder_renamed_in_case_outside_the_app_is_unlocked_by_its_lock_name() {
    let (e, store) = guarded(&[("Archive/Plan.md", NOTE)]);
    if !e.vault.join("ARCHIVE").is_dir() {
        return;
    }
    let locks = Setter::new(&e, store);
    locks.set(TargetKind::Folder, "Archive", true).unwrap();
    assert!(read_only(&e, "Archive/Plan.md"));
    std::fs::rename(e.vault.join("Archive"), e.vault.join("ARCHIVE")).unwrap();
    std::thread::sleep(QUIET);

    let set = locks.set(TargetKind::Folder, "Archive", false).unwrap();
    assert!(set.changed && set.state.folders.is_empty(), "{set:?}");
    assert!(!read_only(&e, "ARCHIVE/Plan.md"));
}
