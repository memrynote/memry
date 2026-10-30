//! The vault tier end to end: a session opens a vault, the watcher reports, the consumer
//! applies, and the facts it publishes say what the rows hold. The single-fact rules are the
//! unit tests in `src/vault/consumer/tests.rs`; these cover what only the running pair does:
//! the order of the start rescan and the open walk, and the stop with the vault.

mod device_key;
mod vault_env;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::consumer::rows::{RowError, RowStat};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::watch::VaultEvent;
use vault_env::{Creates, QUIET, WAIT, creates, env, indexed};

fn position(facts: &[Applied], what: impl Fn(&Applied) -> bool) -> usize {
    facts
        .iter()
        .position(what)
        .unwrap_or_else(|| panic!("not in {facts:?}"))
}

/// The open walk offers the files no row names. Run before the start rescan's removals and
/// moves are applied, it would take a file moved while the app was closed for a new note and
/// give it a second id beside the one its row still holds.
#[test]
fn a_file_moved_while_closed_keeps_its_note_and_the_walk_offers_only_new_files() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.write("old.md", "a note that will move\n");
    e.open();
    e.facts_until(indexed);
    let before = e.rows();
    assert_eq!(before.len(), 1, "{before:?}");
    let id = before[0].0.clone();
    e.close();

    fs::create_dir_all(e.vault.join("dir")).unwrap();
    fs::rename(e.vault.join("old.md"), e.vault.join("dir/moved.md")).unwrap();
    e.write("fresh.md", "new while closed\n");
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    let renamed = position(
        &facts,
        |f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "dir/moved.md"),
    );
    let rescanned = position(&facts, |f| {
        matches!(f, Applied::Vault(VaultEvent::Rescanned { .. }))
    });
    assert!(renamed < rescanned, "{facts:?}");
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Added { path, created: true, .. } if path == "fresh.md"))
    );
    assert_eq!(
        *identity.offered.lock().unwrap(),
        vec!["old.md".to_owned(), "fresh.md".to_owned()],
        "a moved file was offered as a new one"
    );
    let rows = e.rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.contains(&(id, "dir/moved.md".to_owned())), "{rows:?}");
}

#[test]
fn a_file_written_while_open_gets_a_note_and_the_tier_stops_with_the_vault() {
    let mut e = env(|store| Some(creates(store) as Arc<dyn NoteIdentity>));
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("hello.md", "hi\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "hello.md"));
    let session = e.tier.rows().session_for(e.core.as_ref().unwrap()).unwrap();
    e.close();

    e.write("late.md", "x\n");
    std::thread::sleep(QUIET);
    assert!(
        e.drain().is_empty(),
        "the tier kept working after the close"
    );
    let stat = RowStat {
        file_type: FileType::Markdown,
        size: 1,
        content_hash: None,
        file_hash: None,
    };
    assert!(
        matches!(
            e.tier.rows().reserve(session, "n1", "late.md", stat),
            Err(RowError::Closed)
        ),
        "a row was written into a closed vault"
    );
    // The next open's walk finds what was written while the vault was closed.
    e.open();
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "late.md"));
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("again.md", "y\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "again.md"));
}

/// A tier nothing set an identity on runs and indexes nothing.
#[test]
fn a_tier_with_no_identity_records_no_row() {
    let mut e = env(|_| None);
    e.write("a.md", "x\n");
    e.open();
    let facts = e.facts_until(indexed);
    assert!(
        facts.contains(&Applied::Indexed { complete: false }),
        "{facts:?}"
    );
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Added { .. })),
        "{facts:?}"
    );
    assert!(e.rows().is_empty());
}

/// [`Creates`], except for `parked.md`: its offer waits until [`Creates::release`], then deletes
/// `n.md` and names no note, so the fact the consumer applies next finds `n.md` missing.
struct DeletesWhileParked(Arc<Creates>);

impl NoteIdentity for DeletesWhileParked {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        if file.path != "parked.md" {
            return self.0.adopt_or_create(ctx, file);
        }
        self.0.offered.lock().unwrap().push(file.path.to_owned());
        let held = self.0.held.lock().unwrap();
        drop(
            self.0
                .released
                .wait_timeout_while(held, WAIT, |held| *held)
                .unwrap(),
        );
        fs::remove_file(ctx.root.join("n.md")).unwrap();
        Ok(Adoption::Defer)
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        self.0.on_removed(ctx, id, path)
    }

    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), IdentityError> {
        self.0.on_renamed(ctx, id, old_path, new_path)
    }
}

/// A save makes the note's name missing for a moment (#3736): Windows renaming a new file over
/// it, or an editor that deletes the file and writes it again. The consumer reads the note in
/// that moment and finds nothing, and the watcher, which already reported the bytes the save
/// puts back, does not report them again. The read is retried, and the save reaches the note.
#[test]
fn a_save_read_while_its_file_was_missing_reaches_the_note() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(Arc::new(DeletesWhileParked(made)))
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    std::thread::sleep(Duration::from_millis(300));

    // The consumer waits inside the offer of `parked.md`, so the report of the save queues
    // behind it.
    identity.hold();
    e.write("parked.md", "parked\n");
    let deadline = Instant::now() + WAIT;
    while !identity
        .offered
        .lock()
        .unwrap()
        .iter()
        .any(|p| p == "parked.md")
    {
        assert!(Instant::now() < deadline, "parked.md was never offered");
        std::thread::sleep(Duration::from_millis(20));
    }
    e.write("n.md", "saved outside\n");
    std::thread::sleep(QUIET);
    // The offer ends by deleting `n.md`; the consumer reads it at once. The save puts the same
    // bytes back well inside the watcher's rename window, so the watcher sees no removal.
    identity.release();
    std::thread::sleep(Duration::from_millis(200));
    e.write("n.md", "saved outside\n");

    let deadline = Instant::now() + WAIT;
    while e.body(&id) != "saved outside" {
        assert!(Instant::now() < deadline, "the save never reached the note");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A file whose note could not be named is reported again by the watcher, after a delay that
/// doubles, until it gets its note.
#[test]
fn a_file_whose_note_could_not_be_named_is_offered_again_until_it_has_one() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *made.failures.lock().unwrap() = 2;
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("a.md", "x\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "a.md"));
    assert_eq!(identity.offered.lock().unwrap().len(), 3);
    assert_eq!(e.rows().len(), 1);
}
