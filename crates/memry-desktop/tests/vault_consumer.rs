//! The vault tier end to end: a session opens a vault, the watcher reports, the consumer
//! applies, and the facts it publishes say what the rows hold. The single-fact rules are the
//! unit tests in `src/vault/consumer/tests.rs`; these cover what only the running pair does:
//! the order of the start rescan and the open walk, and the stop with the vault.

mod device_key;
mod vault_env;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::StorageError;
use memry_core::domain::external_feed::FeedInput;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::consumer::rows::{RowError, RowStat};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::VaultEvent;
use vault_env::{Creates, Env, QUIET, creates, env, indexed};

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

/// What ships until Step 13 sets its identity: the tier runs and indexes nothing, as the app
/// behaved before it.
#[test]
fn the_shipped_tier_records_no_row_until_step_13_names_notes() {
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

/// Makes a note as [`Creates`] does, with a body of its own before the file is seeded: a body
/// that arrived over sync before this device first read the file.
struct WithBody(Arc<Creates>);

impl NoteIdentity for WithBody {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        let adoption = self.0.adopt_or_create(ctx, file)?;
        if let Adoption::Created(id) = &adoption {
            let other = |error: &dyn std::fmt::Display| IdentityError::Other(error.to_string());
            let feed = ctx
                .vault
                .external_feed(self.0.store.clone())
                .map_err(|e| other(&e))?;
            let input = FeedInput {
                note_id: id,
                markdown: "a body the note already had\n",
                note_path: None,
                writing: Some(Default::default()),
                frontmatter: None,
            };
            feed.seed_body_if_empty(&Converter::new(CalloutTypes::new([])), input)
                .map_err(|e| other(&e))?;
        }
        Ok(adoption)
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

/// An env whose identity makes a note per new file, and that identity. `body_first` gives each
/// note a body before its file is seeded ([`WithBody`]).
fn env_naming_notes(body_first: bool) -> (Env, Arc<Creates>) {
    let identity = Mutex::new(None);
    let e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(if body_first {
            Arc::new(WithBody(made)) as Arc<dyn NoteIdentity>
        } else {
            made
        })
    });
    (e, identity.into_inner().unwrap().unwrap())
}

/// Moves `old.md` into a folder while the vault is closed and opens it: the note `id` keeps
/// its id and its file, and the moved file is not offered as a new note.
fn a_closed_move_pairs(e: &mut Env, identity: &Creates, id: String, case: &str) {
    e.close();
    fs::create_dir_all(e.vault.join("dir")).unwrap();
    fs::rename(e.vault.join("old.md"), e.vault.join("dir/moved.md")).unwrap();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(
        facts.iter().any(|f| matches!(
            f,
            Applied::Renamed { note_id, new_path, .. }
                if note_id == &id && new_path == "dir/moved.md"
        )),
        "{case}: {facts:?}"
    );
    assert_eq!(
        *identity.offered.lock().unwrap(),
        vec!["old.md".to_owned()],
        "{case}: the moved file was offered as a new note"
    );
    assert_eq!(e.rows(), vec![(id, "dir/moved.md".to_owned())], "{case}");
}

fn larger_than_the_editor_takes() -> String {
    "a line of a note past the large-file class\n".repeat(30_000)
}

/// A file whose text the note's document did not take (#3744): too large for the editor,
/// frontmatter that does not parse, or a note that already had a body. Its row names no text
/// the document holds, and a move made while the app was closed still pairs on the bytes the
/// tier read: the note keeps its id and its file, and no second note is made.
#[test]
fn a_file_whose_text_its_note_did_not_take_still_pairs_a_move_made_while_closed() {
    let large = larger_than_the_editor_takes();
    for (case, text, body_first) in [
        ("larger than the editor takes", large.as_str(), false),
        (
            "frontmatter that does not parse",
            "---\ntitle: [\n---\nbody\n",
            false,
        ),
        ("a body the note already had", "the file's own text\n", true),
    ] {
        let (mut e, identity) = env_naming_notes(body_first);
        e.write("old.md", text);
        e.open();
        e.facts_until(indexed);
        let rows = e.rows();
        assert_eq!(rows.len(), 1, "{case}: {rows:?}");
        let id = rows[0].0.clone();
        let row = e.core().note_files().by_id(&id).unwrap().unwrap();
        assert_eq!(row.content_hash, None, "{case}: the document took the text");
        a_closed_move_pairs(&mut e, &identity, id, case);
    }
}

/// A note indexed whole whose file then changed into what its document does not take, while
/// the app was closed (#3744): the row keeps the hash of the text the document holds, and the
/// bytes the tier read at the next open are what a later move pairs on.
#[test]
fn a_note_whose_file_changed_past_what_its_document_takes_still_pairs_a_later_move() {
    let large = larger_than_the_editor_takes();
    for (case, edited) in [
        ("grew larger than the editor takes", large.as_str()),
        (
            "frontmatter that stopped parsing",
            "---\ntitle: [\n---\na small note\n",
        ),
    ] {
        let (mut e, identity) = env_naming_notes(false);
        e.write("old.md", "a small note\n");
        e.open();
        e.facts_until(indexed);
        let id = e.rows()[0].0.clone();
        e.close();

        e.write("old.md", edited);
        e.drain();
        e.open();
        e.facts_until(indexed);
        let row = e.core().note_files().by_id(&id).unwrap().unwrap();
        assert_eq!(
            row.content_hash,
            Some(content_hash("a small note\n")),
            "{case}: the document took the edit"
        );
        a_closed_move_pairs(&mut e, &identity, id, case);
    }
}

/// A row from before file hashes (#3744) whose document never took its file has none: the
/// migration copies only the content hash. The first open reads the file again and records
/// it, so a move made after that pairs.
#[test]
fn a_row_from_before_file_hashes_gets_one_at_the_next_open() {
    let (mut e, identity) = env_naming_notes(false);
    e.write("old.md", &larger_than_the_editor_takes());
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM note_file_hashes", [])
                .map(|_| ())
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .unwrap();
    e.close();

    e.open();
    e.facts_until(indexed);
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    assert!(row.file_hash.is_some(), "{row:?}");
    a_closed_move_pairs(&mut e, &identity, id, "a row from before file hashes");
}
