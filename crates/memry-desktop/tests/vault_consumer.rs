//! The vault tier end to end: a session opens a vault, the watcher reports, the consumer
//! applies, and the facts it publishes say what the rows hold. The single-fact rules are the
//! unit tests in `src/vault/consumer/tests.rs`; these cover what only the running pair does:
//! the order of the start rescan and the open walk, and the stop with the vault.

mod device_key;
mod vault_env;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::NoteIdentity;
use memry_desktop::vault::consumer::rows::{RowError, RowStat};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::watch::VaultEvent;
use vault_env::{QUIET, creates, env, indexed};

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
