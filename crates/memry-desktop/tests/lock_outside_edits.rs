//! A locked note's file changed or removed outside the app gets its locked text back (Step
//! 14e-2b, Electron `restoreLockedNoteFile`, `vault-locks/service.ts`), over a real session,
//! tier, watcher, `data.db` and vault files:
//! - the outside text is kept as a version before the locked text is written back, and never
//!   reaches the note's document;
//! - a removed file comes back, and its note stays;
//! - what changed while the app was closed is put back at the next open;
//! - a revert that could not be written keeps the version, feeds nothing, and the next open
//!   writes it, once however often the vault opens;
//! - a revert writes only over the bytes it kept, or into a path that is free;
//! - a file that is not UTF-8 is kept as the text Electron reads it as, then reverted;
//! - a change that could not be kept as a version is left on disk and fed nowhere;
//! - the app's own writes through the lock (another device's text, the write-back) stay.

use std::fs;
use std::time::{Duration, Instant};

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::locks::{Locks, RestoreError};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::note_file::{NoteFile, NoteFileError};

use crate::lock_service::{NOTE, guarded, lock, read_only, reopen, unlock};
use crate::notes_link_rewrite::id_at;
use crate::vault_env::{Env, QUIET, WAIT, indexed};

const OUTSIDE: &str = "Written outside the app.\n";

pub(crate) fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// An editor's in-place save of a read-only file: it makes the file writable first.
pub(crate) fn edit_outside(e: &Env, rel: &str, text: &str) {
    let path = e.vault.join(rel);
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(&path, permissions).unwrap();
    fs::write(path, text).unwrap();
}

fn kept_outside_text(e: &Env, id: &str) -> usize {
    e.versions(id).iter().filter(|v| *v == OUTSIDE).count()
}

/// The note at `rel`, locked by `kind`, its lock applied by an open.
fn locked(files: &[(&str, &str)], rel: &str, kind: TargetKind) -> (Env, String) {
    let (mut e, _) = guarded(files);
    let id = id_at(&e, rel);
    let target = match kind {
        TargetKind::Note => id.clone(),
        _ => rel.rsplit_once('/').unwrap().0.to_owned(),
    };
    lock(&e, kind, &target);
    reopen(&mut e);
    // The watcher's start settles before the test edits the file.
    std::thread::sleep(Duration::from_millis(300));
    (e, id)
}

fn assert_locked_text(e: &Env, rel: &str, id: &str) {
    assert_eq!(e.read(rel), NOTE);
    assert!(read_only(e, rel), "{rel} is read-only again");
    assert_eq!(
        e.body(id),
        "The body.",
        "the outside text reached the document"
    );
    assert_eq!(kept_outside_text(e, id), 1, "{:?}", e.versions(id));
}

#[test]
fn an_outside_edit_of_a_locked_note_is_kept_as_a_version_and_reverted() {
    let (e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);

    edit_outside(&e, "Plan.md", OUTSIDE);

    until("the outside text is kept", || {
        kept_outside_text(&e, &id) > 0
    });
    until("the locked text is back", || e.read("Plan.md") == NOTE);
    std::thread::sleep(QUIET);
    assert_locked_text(&e, "Plan.md", &id);
}

#[test]
fn an_outside_edit_in_a_locked_folder_is_kept_as_a_version_and_reverted() {
    let rel = "Archive/Old.md";
    let (e, id) = locked(&[(rel, NOTE)], rel, TargetKind::Folder);

    edit_outside(&e, rel, OUTSIDE);

    until("the locked text is back", || {
        kept_outside_text(&e, &id) > 0 && e.read(rel) == NOTE
    });
    std::thread::sleep(QUIET);
    assert_locked_text(&e, rel, &id);
}

/// A removal would delete the note on every device (`watcher.ts`).
#[test]
fn a_locked_note_removed_outside_comes_back_and_keeps_its_note() {
    let (mut e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);

    fs::remove_file(e.vault.join("Plan.md")).unwrap();

    until("the file is back", || {
        fs::read_to_string(e.vault.join("Plan.md")).is_ok_and(|text| text == NOTE)
    });
    std::thread::sleep(QUIET);
    assert_eq!(e.read("Plan.md"), NOTE);
    assert_eq!(id_at(&e, "Plan.md"), id);
    assert_eq!(e.body(&id), "The body.");
    reopen(&mut e);
    assert_eq!(id_at(&e, "Plan.md"), id, "the next open keeps it too");
}

#[test]
fn a_locked_note_edited_or_removed_while_closed_is_put_back_at_open() {
    let (mut e, id) = locked(
        &[("Plan.md", NOTE), ("Other.md", NOTE)],
        "Plan.md",
        TargetKind::Note,
    );
    let other = id_at(&e, "Other.md");
    lock(&e, TargetKind::Note, &other);
    reopen(&mut e);
    e.close();

    edit_outside(&e, "Plan.md", OUTSIDE);
    fs::remove_file(e.vault.join("Other.md")).unwrap();
    e.open();
    e.facts_until(indexed);

    until("both are back", || {
        e.read("Plan.md") == NOTE
            && fs::read_to_string(e.vault.join("Other.md")).is_ok_and(|text| text == NOTE)
    });
    std::thread::sleep(QUIET);
    assert_locked_text(&e, "Plan.md", &id);
    assert_eq!(id_at(&e, "Other.md"), other);
}

/// The text a revert would write over is kept first; a revert that cannot land (here: a folder
/// that takes no new file, as a crash between the two steps would leave it) feeds nothing, and
/// every later open finds the version kept once and the locked text on disk.
#[cfg(unix)]
#[test]
fn a_revert_that_did_not_land_keeps_the_version_and_the_next_opens_write_it_once() {
    use std::os::unix::fs::PermissionsExt;
    let rel = "Work/Plan.md";
    let (mut e, id) = locked(&[(rel, NOTE)], rel, TargetKind::Note);
    let folder = e.vault.join("Work");
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();

    edit_outside(&e, rel, OUTSIDE);
    until("the outside text is kept", || {
        kept_outside_text(&e, &id) > 0
    });
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(e.read(rel), OUTSIDE, "the folder takes no file");
    assert_eq!(
        e.body(&id),
        "The body.",
        "the outside text reached the document"
    );
    e.close();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();

    for open in 1..=3 {
        e.open();
        e.facts_until(indexed);
        until("the locked text is back", || e.read(rel) == NOTE);
        std::thread::sleep(QUIET);
        assert_locked_text(&e, rel, &id);
        assert_eq!(
            e.versions(&id).len(),
            1,
            "open {open}: {:?}",
            e.versions(&id)
        );
        e.close();
    }
}

/// The app's own write through the lock records its text as the one the lock holds, so the
/// watcher's report of it is no outside edit.
#[test]
fn the_apps_own_write_through_the_lock_stays() {
    let (e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);
    let own = "Another device's text.\n";

    let open = e.session.current().unwrap();
    let path = e.vault.join("Plan.md");
    Locks::of(&open)
        .write_through("Plan.md", own, || fs::write(&path, own))
        .unwrap();
    drop(open);

    std::thread::sleep(QUIET * 2);
    assert_eq!(e.read("Plan.md"), own);
    assert!(read_only(&e, "Plan.md"));
    assert!(
        e.versions(&id).iter().all(|v| v != own),
        "{:?}",
        e.versions(&id)
    );
}

/// A locked note's document takes another device's edits; its write-back lands and stays, and
/// becomes the text an outside edit right after it is reverted to (Electron's write-back window,
/// `watcher.ts` `checkLockedFileInWritebackWindow`, #2606).
#[test]
fn a_locked_notes_write_back_lands_and_stays() {
    let (mut e, store) = guarded(&[("Plan.md", NOTE)]);
    let id = id_at(&e, "Plan.md");
    e.edit_in_app(&store, &id, "From another device");
    lock(&e, TargetKind::Note, &id);
    std::thread::sleep(Duration::from_millis(300));

    e.tier.schedule(&id);
    until("the write-back lands", || {
        e.read("Plan.md") == "From another device\n"
    });
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.read("Plan.md"), "From another device\n");
    assert_eq!(e.body(&id), "From another device");
    let baseline = e.core().locks().baseline(&id).unwrap().unwrap();
    assert_eq!(baseline.content, "From another device\n");

    edit_outside(&e, "Plan.md", OUTSIDE);
    until("the written-back text is back", || {
        kept_outside_text(&e, &id) == 1 && e.read("Plan.md") == "From another device\n"
    });
    assert_eq!(e.body(&id), "From another device");
}

/// A lock whose open has not recorded the note's text yet (Electron's fallback): the outside
/// edit goes on as any, and becomes the text the next one is reverted to.
#[test]
fn a_locked_note_without_its_text_recorded_takes_the_outside_edit_as_it() {
    let (e, _) = guarded(&[("Plan.md", NOTE)]);
    let id = id_at(&e, "Plan.md");
    lock(&e, TargetKind::Note, &id);
    std::thread::sleep(Duration::from_millis(300));

    edit_outside(&e, "Plan.md", OUTSIDE);
    until("the outside edit is fed", || {
        e.body(&id) == "Written outside the app."
    });
    let baseline = e.core().locks().baseline(&id).unwrap().unwrap();
    assert_eq!(baseline.content, OUTSIDE);

    edit_outside(&e, "Plan.md", "Again.\n");
    until("the recorded text is back", || e.read("Plan.md") == OUTSIDE);
    assert_eq!(e.body(&id), "Written outside the app.");
    assert!(e.versions(&id).iter().any(|v| v == "Again.\n"));
}

/// An unlocked note's text is still recorded until the next open drops it; its outside edit is
/// the user's, and goes on.
#[test]
fn an_unlocked_notes_outside_edit_is_taken() {
    let (e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);
    unlock(&e, TargetKind::Note, &id);

    edit_outside(&e, "Plan.md", OUTSIDE);

    until("the outside edit is fed", || {
        e.body(&id) == "Written outside the app."
    });
    std::thread::sleep(QUIET);
    assert_eq!(e.read("Plan.md"), OUTSIDE);
}

/// The lock, its baseline and its vault, with the app closed: nothing but the test touches the
/// file, which holds `on_disk`.
fn closed_with(on_disk: &str) -> (Env, std::sync::Arc<memry_core::api::vault::Vault>, String) {
    let (mut e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);
    let core = e.core();
    e.close();
    edit_outside(&e, "Plan.md", on_disk);
    (e, core, id)
}

/// The bytes a revert would write over are the ones it kept: a newer edit landed since is not
/// written over unkept.
#[test]
fn a_revert_does_not_write_over_bytes_newer_than_the_ones_it_kept() {
    let (e, core, id) = closed_with("Newer.\n");
    let kept = NoteFile {
        raw: OUTSIDE.to_owned(),
        hash: content_hash(OUTSIDE),
    };

    let refused = Locks::new(&e.vault, &core).restore(&id, "Plan.md", Some(&kept));

    assert!(
        matches!(
            refused,
            Err(RestoreError::Write(NoteFileError::ChangedUnderWrite))
        ),
        "{refused:?}"
    );
    assert_eq!(e.read("Plan.md"), "Newer.\n");
}

/// A removed file is written back only into a free path: a file that appeared there since is
/// not written over.
#[test]
fn a_removed_file_is_not_written_back_over_one_that_appeared() {
    let (e, core, id) = closed_with("Appeared.\n");

    let refused = Locks::new(&e.vault, &core).restore(&id, "Plan.md", None);

    assert!(
        matches!(
            refused,
            Err(RestoreError::Write(NoteFileError::AlreadyExists))
        ),
        "{refused:?}"
    );
    assert_eq!(e.read("Plan.md"), "Appeared.\n");
}

#[test]
fn an_outside_write_that_is_not_utf8_is_kept_as_text_and_reverted() {
    let (e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);
    edit_outside(&e, "Plan.md", "");

    fs::write(e.vault.join("Plan.md"), [0xff, 0xfe, b'A']).unwrap();

    until("the locked text is back", || {
        fs::read(e.vault.join("Plan.md")).unwrap() == NOTE.as_bytes()
    });
    std::thread::sleep(QUIET);
    assert_eq!(e.read("Plan.md"), NOTE);
    assert!(read_only(&e, "Plan.md"));
    assert_eq!(e.body(&id), "The body.");
    let versions = e.versions(&id);
    assert!(
        versions.iter().any(|v| v == "\u{FFFD}\u{FFFD}A"),
        "{versions:?}"
    );
}

/// Safer than Electron, which feeds a change it could not keep: the lock holds, the change
/// stays on disk, and the retry after the versions take rows again keeps it and reverts. Only
/// the outside text's version fails: a feed keeps a version of the body it replaces, and the
/// test must not stop that one.
#[test]
fn a_change_that_cannot_be_kept_stays_on_disk_and_is_not_fed() {
    let (e, id) = locked(&[("Plan.md", NOTE)], "Plan.md", TargetKind::Note);
    let versions = |sql: &'static str| {
        e.core()
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute_batch(sql).unwrap();
                Ok(())
            })
            .unwrap();
    };
    versions(
        "CREATE TRIGGER no_versions BEFORE INSERT ON note_snapshots \
         WHEN NEW.content LIKE 'Written outside%' \
         BEGIN SELECT RAISE(ABORT, 'no versions'); END;",
    );

    edit_outside(&e, "Plan.md", OUTSIDE);
    std::thread::sleep(QUIET);
    assert_eq!(e.read("Plan.md"), OUTSIDE);
    assert_eq!(e.body(&id), "The body.", "the unkept change was fed");

    versions("DROP TRIGGER no_versions;");
    until("the retry keeps it and reverts", || {
        e.read("Plan.md") == NOTE
    });
    std::thread::sleep(QUIET);
    assert_locked_text(&e, "Plan.md", &id);
}
