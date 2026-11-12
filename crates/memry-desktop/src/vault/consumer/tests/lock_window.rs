//! A lock change made while a write-back writes the note's file (#4103's review): the change
//! waits for the pass to write and stamp the file, so the lock covers the file the pass left.
//! Before, a lock in that window recorded the replaced text as the baseline and left the new
//! file writable, and the next outside edit was reverted to the replaced text, a rollback that
//! syncs; an unlock there had the write make the freed file read-only again with a baseline.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use memry_core::domain::vault_locks::TargetKind;

use super::typing_wins::{note, type_in_app};
use super::*;
use crate::locks::{AFTER_ROW, LockSet, Locks};
use crate::notes::error::NotesError;
use crate::vault::writeback::{Outcome, Pass};

const TYPED: &str = "typed in the app\n";

/// The app's lock change from another thread, as a window's command makes it.
fn set_lock(
    f: &Fixture,
    session: RowSession,
    id: &str,
    locked: bool,
) -> JoinHandle<Result<LockSet, NotesError>> {
    let (root, vault, rows) = (f.root.clone(), f.vault.clone(), f.rows.clone());
    let id = id.to_owned();
    std::thread::spawn(move || {
        Locks::new(&root, &vault).set(&rows, session, TargetKind::Note, &id, locked, "device-a")
    })
}

/// Runs the pass with the lock change made inside its write: started after the new file is
/// written aside, and let run until it is done or waits for the rows' lane.
fn pass_with_lock_change(f: &Fixture, pass: &Pass, id: &str, locked: bool) -> Outcome {
    let mut change = None;
    let session = f.session();
    let outcome = pass.run_checked(id, &mut || {
        let handle = set_lock(f, session, id, locked);
        while !handle.is_finished() && f.rows.waiting() == 0 {
            std::thread::yield_now();
        }
        change = Some(handle);
    });
    let set = change.expect("the pass wrote").join().unwrap().unwrap();
    assert!(set.changed);
    outcome
}

fn read_only(f: &Fixture) -> bool {
    std::fs::metadata(f.root.join("n.md"))
        .unwrap()
        .permissions()
        .readonly()
}

fn baseline(f: &Fixture, id: &str) -> Option<String> {
    f.vault.locks().baseline(id).unwrap().map(|b| b.content)
}

#[test]
fn a_lock_during_a_write_back_records_the_written_text_and_reverts_to_it() {
    let f = fixture();
    let (id, pass) = note(&f);
    type_in_app(&f, &id, TYPED.trim_end());

    let outcome = pass_with_lock_change(&f, &pass, &id, true);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(std::fs::read_to_string(f.root.join("n.md")).unwrap(), TYPED);
    assert_eq!(baseline(&f, &id).as_deref(), Some(TYPED));
    assert!(read_only(&f), "the written file is not protected");

    let path = f.root.join("n.md");
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    std::fs::set_permissions(&path, permissions).unwrap();
    f.write("n.md", "edited outside\n");
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), TYPED);
    assert_eq!(f.body(&id), TYPED.trim_end());
}

#[test]
fn an_unlock_during_a_write_back_leaves_the_file_free() {
    let f = fixture();
    let (id, pass) = note(&f);
    type_in_app(&f, &id, TYPED.trim_end());
    Locks::new(&f.root, &f.vault)
        .set(
            &f.rows,
            f.session(),
            TargetKind::Note,
            &id,
            true,
            "device-a",
        )
        .unwrap();
    assert!(read_only(&f));

    let outcome = pass_with_lock_change(&f, &pass, &id, false);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    let locks = f.vault.locks();
    assert!(!locks.is_note_locked(&id, None).unwrap());
    assert!(!read_only(&f), "the unlocked file was made read-only again");
    assert_eq!(baseline(&f, &id), None);
    assert!(locks.file_modes().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(f.root.join("n.md")).unwrap(), TYPED);
}

/// A lock change keeps the lane through its reconcile, not only its row write. The change is
/// held after its row write until the pass is inside its write or waits for the lane: let go
/// with the row, the reconcile runs inside the write and makes the file under it read-only
/// again, so on Windows the replace is refused and the baseline stays the replaced text.
#[test]
fn a_lock_keeps_the_lane_through_its_reconcile() {
    let f = fixture();
    let (id, pass) = note(&f);
    type_in_app(&f, &id, TYPED.trim_end());
    let session = f.session();
    let (paused, row_written) = mpsc::channel();
    let (go, resume) = mpsc::channel();
    let change = {
        let (root, vault, rows, id) = (f.root.clone(), f.vault.clone(), f.rows.clone(), id.clone());
        std::thread::spawn(move || {
            AFTER_ROW.set(Some(Box::new(move || {
                paused.send(()).unwrap();
                resume.recv().unwrap();
            })));
            Locks::new(&root, &vault).set(&rows, session, TargetKind::Note, &id, true, "device-a")
        })
    };
    row_written.recv().unwrap();

    let in_write = AtomicBool::new(false);
    let mut read_only_in_write = false;
    let outcome = std::thread::scope(|scope| {
        let written = scope.spawn(|| {
            pass.run_checked(&id, &mut || {
                in_write.store(true, Ordering::SeqCst);
                while !change.is_finished() {
                    std::thread::yield_now();
                }
                read_only_in_write = read_only(&f);
            })
        });
        while !in_write.load(Ordering::SeqCst) && f.rows.waiting() == 0 {
            std::thread::yield_now();
        }
        go.send(()).unwrap();
        written.join().unwrap()
    });
    assert!(change.join().unwrap().unwrap().changed);

    assert!(!read_only_in_write, "the reconcile ran inside the write");
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(std::fs::read_to_string(f.root.join("n.md")).unwrap(), TYPED);
    assert_eq!(baseline(&f, &id).as_deref(), Some(TYPED));
    assert!(read_only(&f), "the written file is not protected");
}
