//! The pairing hash of a note's file (#3744), end to end through the running tier: a note
//! moved while the app was closed keeps its id when the tier knows the bytes it left, whether
//! or not its document took them, and pairs with nothing when it does not: no file of other
//! bytes, no file of a note whose file went, and no one of several identical files its name
//! does not single out takes its id.

mod device_key;
mod vault_env;

use std::fs;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::domain::external_feed::FeedInput;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::hash::content_hash;
use vault_env::{Creates, Env, creates, env, indexed};

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
/// its id and its file, the moved file is not offered as a new note, and nothing else changes.
fn a_closed_move_pairs(e: &mut Env, identity: &Creates, id: String, case: &str) {
    let offered = identity.offered.lock().unwrap().clone();
    let mut rows: Vec<_> = e
        .rows()
        .into_iter()
        .map(|(note, path)| {
            let path = if note == id {
                "dir/moved.md".to_owned()
            } else {
                path
            };
            (note, path)
        })
        .collect();
    rows.sort();
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
        offered,
        "{case}: the moved file was offered as a new note"
    );
    let mut now = e.rows();
    now.sort();
    assert_eq!(now, rows, "{case}");
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

/// A file changed while the app was closed whose text the note's document could not store
/// (the database refused the write): the open read its bytes, so a move made before the
/// retry stores the text still pairs on them.
#[test]
fn a_file_read_whose_text_could_not_be_stored_still_pairs_a_move_made_while_closed() {
    let (mut e, identity) = env_naming_notes(false);
    e.write("old.md", "a small note\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    exec(
        &e,
        "CREATE TRIGGER no_body BEFORE INSERT ON yjs_updates \
         BEGIN SELECT RAISE(ABORT, 'the disk is full'); END",
    );
    e.close();

    e.write("old.md", "a small note, edited\n");
    e.drain();
    e.open();
    e.facts_until(indexed);
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    assert_eq!(
        row.content_hash,
        Some(content_hash("a small note\n")),
        "the document took the edit"
    );
    a_closed_move_pairs(&mut e, &identity, id, "a body the database refused");
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

/// Runs `sql` on the open vault's database.
fn exec(e: &Env, sql: &'static str) {
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute_batch(sql)
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .unwrap();
}

fn renamed(facts: &[Applied]) -> Vec<(String, String)> {
    facts
        .iter()
        .filter_map(|f| match f {
            Applied::Renamed {
                note_id, new_path, ..
            } => Some((note_id.clone(), new_path.clone())),
            _ => None,
        })
        .collect()
}

/// A note whose file went while its record stays (13d keeps it): its row names no bytes, so a
/// file with the same bytes that shows up later anywhere is a new note's, not this one's move.
#[test]
fn a_note_whose_file_went_pairs_with_no_file_that_shows_up_later() {
    let (mut e, identity) = env_naming_notes(false);
    e.write("a.md", "the same bytes\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    e.close();

    fs::remove_file(e.vault.join("a.md")).unwrap();
    e.drain();
    e.open();
    e.facts_until(indexed);
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    assert_eq!(
        (row.content_hash, row.file_hash),
        (None, None),
        "kept, naming no bytes"
    );
    e.close();

    e.write("other/b.md", "the same bytes\n");
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert_eq!(renamed(&facts), vec![], "{facts:?}");
    assert_eq!(
        *identity.offered.lock().unwrap(),
        vec!["a.md".to_owned(), "other/b.md".to_owned()]
    );
}

/// A file this build reads only as bytes (here not UTF-8) pairs on the hash of those bytes, the
/// hash the watcher computes for its move. A file whose read failed (here a second hard link,
/// which the tier refuses) leaves its row no hash at all.
#[test]
fn a_file_read_only_as_bytes_pairs_and_one_not_read_names_no_bytes() {
    let (mut e, identity) = env_naming_notes(false);
    e.write("old.md", "a small note\n");
    e.write("linked.md", "another note\n");
    e.open();
    e.facts_until(indexed);
    let id_of = |e: &Env, path: &str| e.rows().into_iter().find(|(_, p)| p == path).unwrap().0;
    let (id, linked) = (id_of(&e, "old.md"), id_of(&e, "linked.md"));
    e.close();

    fs::write(e.vault.join("old.md"), b"not \xff UTF-8 any more\n").unwrap();
    e.write("linked.md", "another note, edited\n");
    let outside = tempfile::tempdir().unwrap();
    fs::hard_link(e.vault.join("linked.md"), outside.path().join("link.md")).unwrap();
    e.drain();
    e.open();
    e.facts_until(indexed);
    let row = e.core().note_files().by_id(&linked).unwrap().unwrap();
    assert_eq!(row.file_hash, None, "a hash of bytes the tier did not read");
    fs::remove_file(e.vault.join("linked.md")).unwrap();
    a_closed_move_pairs(&mut e, &identity, id, "not UTF-8");
}

/// Identical files moved while the app was closed, into folders that list in the other order:
/// each keeps its own note by its name. Two the name does not tell apart pair with nothing.
#[test]
fn identical_files_moved_together_keep_their_own_notes_or_pair_with_none() {
    let (mut e, identity) = env_naming_notes(false);
    for path in ["a.md", "b.md", "c.md", "sub/c.md"] {
        e.write(path, "the same bytes\n");
    }
    e.open();
    e.facts_until(indexed);
    let rows = e.rows();
    let id_of = |path: &str| rows.iter().find(|(_, p)| p == path).unwrap().0.clone();
    let (a, b) = (id_of("a.md"), id_of("b.md"));
    e.close();

    for (from, to) in [
        ("a.md", "x/a.md"),
        ("b.md", "w/b.md"),
        ("c.md", "y/c.md"),
        ("sub/c.md", "z/c.md"),
    ] {
        fs::create_dir_all(e.vault.join(to).parent().unwrap()).unwrap();
        fs::rename(e.vault.join(from), e.vault.join(to)).unwrap();
    }
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    let mut pairs = renamed(&facts);
    pairs.sort();
    let mut want = vec![(a, "x/a.md".to_owned()), (b, "w/b.md".to_owned())];
    want.sort();
    assert_eq!(pairs, want, "{facts:?}");
    let offered = identity.offered.lock().unwrap();
    assert!(
        offered.contains(&"y/c.md".to_owned()) && offered.contains(&"z/c.md".to_owned()),
        "{offered:?}"
    );
}

/// A file hash that names other bytes than the row's content hash (an older build wrote the
/// row) is read again at the next open, which mends it: a move after that pairs.
#[test]
fn a_file_hash_an_older_build_left_behind_is_mended_at_the_next_open() {
    let (mut e, identity) = env_naming_notes(false);
    e.write("old.md", "a small note\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    exec(&e, "UPDATE note_file_hashes SET file_hash = '00000000'");
    e.close();

    e.open();
    e.facts_until(indexed);
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    assert_eq!(row.file_hash, Some(content_hash("a small note\n")));
    a_closed_move_pairs(&mut e, &identity, id, "a hash an older build left");
}
