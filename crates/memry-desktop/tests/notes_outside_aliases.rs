//! An edit outside the app to a file's frontmatter `aliases:` reaching its record (#5599), under
//! the running vault tier with `NotesIdentity`: the record of a note or a journal day takes the
//! file's list whole, as desktop's watcher does (`extractAliases`, `vault/note-sync.ts` and
//! `vault/journal.ts`), so the next push carries it and a pull of that record keeps it.

use memry_core::markdown::shared::markdown_class::NOTE_MAX_BYTES;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use std::sync::Arc;

use memry_desktop::notes::aliases::NoteAliasEditInput;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;

use crate::index_support::until;
use crate::notes_outside_tags::{clear_outbox, edited_outside, opened, upserts};
use crate::vault_env::{Env, QUIET, env, indexed};

/// The record's `aliases`, as its payload holds them.
pub(crate) fn record_aliases(e: &Env, item_type: &'static str, id: &str) -> Vec<String> {
    let id = id.to_owned();
    let payload: String = e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [item_type, &id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    serde_json::from_value(payload["aliases"].clone()).unwrap_or_default()
}

/// The id of the row at `rel`.
pub(crate) fn id_at(e: &Env, rel: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, path)| path == rel)
        .unwrap_or_else(|| panic!("no row at {rel}"))
        .0
}

/// A file first named by the tier gives its new record its aliases, and that record's queued
/// push carries them (#5783).
fn adopted_with_aliases(e: &Env, item_type: &'static str, rel: &str, aliases: &[&str]) {
    let id = id_at(e, rel);
    assert_eq!(record_aliases(e, item_type, &id), aliases, "{rel}");
    assert!(upserts(e, &id) >= 1, "{rel} queued no push");
}

#[test]
fn the_open_walk_gives_found_files_their_aliases() {
    // `Plan.md` and `Other.md` are new notes the walk creates together, the day alone.
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write(
        "Plan.md",
        "---\naliases: [Blueprint, Plan]\n---\nAbout it\n",
    );
    e.write("Other.md", "---\naliases: Second\n---\nElse\n");
    e.write("Bad.md", "---\naliases: [a\n---\nBroken\n");
    e.write(
        "journal/2025-03-05.md",
        "---\ndate: 2025-03-05\naliases: [First]\n---\nBy the river.\n",
    );
    e.open();
    e.facts_until(indexed);
    adopted_with_aliases(&e, "note", "Plan.md", &["Blueprint"]);
    adopted_with_aliases(&e, "note", "Other.md", &["Second"]);
    adopted_with_aliases(&e, "note", "Bad.md", &[]);
    adopted_with_aliases(&e, "journal", "journal/2025-03-05.md", &["First"]);
    e.close();
}

#[test]
fn a_file_made_outside_the_app_gives_its_new_record_its_aliases() {
    let (mut e, _store) = opened();
    e.watcher_live();
    for (rel, text) in [
        ("Idea.md", "---\naliases: [Spark]\n---\nA thought\n"),
        (
            "journal/2025-03-06.md",
            "---\ndate: 2025-03-06\naliases: [Rain day]\n---\nWet.\n",
        ),
    ] {
        e.write(rel, text);
        e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == rel));
    }
    adopted_with_aliases(&e, "note", "Idea.md", &["Spark"]);
    adopted_with_aliases(&e, "journal", "journal/2025-03-06.md", &["Rain day"]);
}

#[test]
fn an_outside_edit_of_a_notes_aliases_reaches_its_record_once_per_change() {
    let (mut e, store) = opened();
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "Plan".into(),
        content: "About it".into(),
        ..NewNoteFile::default()
    };
    let id = notes.create(&open, note).unwrap().id;
    std::thread::sleep(QUIET);
    e.drain();

    // `Blueprint` added in another editor; the title itself is no alias.
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        "Plan.md",
        "---\naliases: [Blueprint, Plan]\n---\nAbout it\n",
    );
    assert_eq!(record_aliases(&e, "note", &id), ["Blueprint"]);
    assert_eq!(upserts(&e, &id), 1);

    // A body edit that leaves the list as the record has it pushes no record.
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        "Plan.md",
        "---\naliases: [Blueprint]\n---\nAbout it, again\n",
    );
    assert_eq!(record_aliases(&e, "note", &id), ["Blueprint"]);
    assert_eq!(upserts(&e, &id), 0);

    // A block that does not parse says nothing about the aliases.
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        "Plan.md",
        "---\naliases: [a\n---\nAbout it, again\n",
    );
    assert_eq!(record_aliases(&e, "note", &id), ["Blueprint"]);
    assert_eq!(upserts(&e, &id), 0);

    // The key removed: no aliases.
    clear_outbox(&e);
    edited_outside(&mut e, &id, "Plan.md", "About it, again\n");
    assert!(record_aliases(&e, "note", &id).is_empty());
    assert_eq!(upserts(&e, &id), 1);
}

#[test]
fn an_outside_edit_of_a_days_aliases_reaches_its_record() {
    let (mut e, _store) = opened();
    let date = "2025-03-05";
    let (id, rel) = (format!("j{date}"), format!("journal/{date}.md"));
    e.write(&rel, "---\ndate: 2025-03-05\n---\nBy the river.\n");
    e.facts_until(|f| matches!(f, Applied::Added { note_id, .. } if *note_id == id));

    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        &rel,
        "---\ndate: 2025-03-05\naliases: [River day]\n---\nBy the river.\n",
    );
    assert_eq!(record_aliases(&e, "journal", &id), ["River day"]);
    assert_eq!(upserts(&e, &id), 1);
}

/// A large-file class file first named gives its record its aliases (#5423), and the record
/// takes the file's list again when the file shrinks out of the class.
#[test]
fn a_large_file_first_named_gives_its_record_its_aliases() {
    let (mut e, _store) = opened();
    e.watcher_live();
    let big = "word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1);
    e.write("Dump.md", &format!("---\naliases: [Heap]\n---\n{big}"));
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Dump.md"));
    let id = id_at(&e, "Dump.md");
    assert_eq!(record_aliases(&e, "note", &id), ["Heap"]);

    e.write("Dump.md", "---\naliases: [Small]\n---\nSmall now\n");
    until("the shrunk file's aliases reach the record", || {
        record_aliases(&e, "note", &id) == ["Small"]
    });
}

/// A pulled note `pulled` titled `title`, no row names, with `content`, `aliases` and a
/// `modifiedAt`.
fn pulled_note(e: &Env, title: &str, content: &str, aliases: &[&str], modified_at: &str) {
    pulled_note_in(e, None, (title, content), aliases, modified_at);
}

/// [`pulled_note`] in the folder `folder`.
pub(crate) fn pulled_note_in(
    e: &Env,
    folder: Option<&str>,
    (title, content): (&str, &str),
    aliases: &[&str],
    modified_at: &str,
) {
    let record = InboundRecord {
        item_type: "note".to_owned(),
        item_id: "pulled".to_owned(),
        payload_json: serde_json::json!({
            "title": title,
            "content": content,
            "fileType": "markdown",
            "folderPath": folder,
            "aliases": aliases,
            "clock": {"device-b": 1},
            "createdAt": "2025-01-01T00:00:00.000Z",
            "modifiedAt": modified_at,
        })
        .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1_760_000_000_000,
        deleted_at: None,
    };
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            sync_items::apply_remote(conn, &record, 1_760_000_000_000).map(drop)
        })
        .unwrap();
}

/// `Plan.md` written with `aliases: [FromFile]` over a pulled record whose body it matches
/// (`Adopted::Existing`) and whose `modifiedAt` is `modified_at`.
fn adopted_plan(modified_at: &str, aliases: &[&str]) -> (Env, Arc<dyn SecureStore>) {
    let (mut e, store) = opened();
    e.watcher_live();
    pulled_note(&e, "Plan", "Body\n", aliases, modified_at);
    e.write("Plan.md", "---\naliases: [FromFile]\n---\nBody\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Plan.md"));
    assert_eq!(id_at(&e, "Plan.md"), "pulled");
    (e, store)
}

pub(crate) const NEWER: &str = "2999-01-01T00:00:00.000Z";

/// Waits until the write-back gave `rel` the list `aliases`, then until the tier is quiet.
pub(crate) fn file_holds(e: &mut Env, rel: &str, aliases: &[&str]) {
    let list: String = aliases.iter().map(|name| format!("  - {name}\n")).collect();
    until("the write-back gives the file the record's aliases", || {
        e.read(rel).contains(&format!("aliases:\n{list}"))
    });
    std::thread::sleep(QUIET);
    e.drain();
}

/// A record modified after the file that matched it keeps its own aliases, and the write-back
/// gives the file that list, the body as it was, and pushes nothing (#5423).
#[test]
fn a_matched_record_newer_than_its_file_keeps_its_aliases_and_gives_them_to_the_file() {
    let (mut e, _store) = adopted_plan(NEWER, &["Newer"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    clear_outbox(&e);
    file_holds(&mut e, "Plan.md", &["Newer"]);
    assert_eq!(e.read("Plan.md"), "---\naliases:\n  - Newer\n---\nBody\n");
    assert_eq!(
        upserts(&e, "pulled"),
        0,
        "the file written back is the app's own"
    );
}

/// A record modified before the file that matched it takes the file's aliases (#5423).
#[test]
fn a_matched_record_older_than_its_file_takes_its_aliases() {
    let (e, _store) = adopted_plan("2001-01-01T00:00:00.000Z", &["Older"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["FromFile"]);
}

/// The file `rel` with its body replaced by `body`, every frontmatter line as it is on disk.
pub(crate) fn body_edited(e: &Env, rel: &str, body: &str) -> String {
    let text = e.read(rel);
    let end = text.find("\n---\n").expect("a frontmatter block") + "\n---\n".len();
    format!("{}{body}", &text[..end])
}

/// Once the file holds the newer record's aliases (REVIEW-5808, VERIFY-5808R2), a body edit
/// outside keeps them and pushes nothing, and an edit of the list is taken.
#[test]
fn outside_edits_after_a_newer_records_adoption_are_measured_against_its_aliases() {
    let (mut e, _store) = adopted_plan(NEWER, &["Newer"]);
    file_holds(&mut e, "Plan.md", &["Newer"]);

    clear_outbox(&e);
    let text = body_edited(&e, "Plan.md", "Body edited outside\n");
    edited_outside(&mut e, "pulled", "Plan.md", &text);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert_eq!(upserts(&e, "pulled"), 0);

    clear_outbox(&e);
    edited_outside(
        &mut e,
        "pulled",
        "Plan.md",
        "---\naliases: [Renamed]\n---\nBody edited outside\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Renamed"]);
    assert_eq!(upserts(&e, "pulled"), 1);
}

/// An in-app alias edit after a newer record's adoption builds on the record's list, and an
/// outside edit that removes the added name is taken (VERIFY-5808R2 finding 2 and 3).
#[test]
fn an_outside_removal_of_an_alias_added_in_the_app_is_taken() {
    let (mut e, store) = adopted_plan(NEWER, &["Newer"]);
    file_holds(&mut e, "Plan.md", &["Newer"]);
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();
    let edit = NoteAliasEditInput {
        id: "pulled".to_owned(),
        add: vec!["X".to_owned()],
        remove: Vec::new(),
    };
    notes.edit_aliases(&open, &edit).unwrap();
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer", "X"]);
    std::thread::sleep(QUIET);
    e.drain();

    clear_outbox(&e);
    edited_outside(
        &mut e,
        "pulled",
        "Plan.md",
        "---\naliases:\n  - Newer\n---\nBody\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert_eq!(upserts(&e, "pulled"), 1);
}

/// A large file matched a newer bare record, which kept its aliases: once the file shrinks out
/// of the class with a body edit alone, the record still keeps them, and the file takes them
/// (VERIFY-5808R2 finding 1).
#[test]
fn a_large_file_that_shrinks_with_a_body_edit_keeps_a_newer_records_aliases() {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note(&e, "Dump", "", &["Newer"], NEWER);
    let big = "word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1);
    e.write("Dump.md", &format!("---\naliases: [Old]\n---\n{big}"));
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Dump.md"));
    assert_eq!(id_at(&e, "Dump.md"), "pulled");
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    // The large file takes the names first (#5825); the shrink then edits its body alone.
    file_holds(&mut e, "Dump.md", &["Newer"]);

    e.write("Dump.md", &body_edited(&e, "Dump.md", "Small now\n"));
    file_holds(&mut e, "Dump.md", &["Newer"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert!(e.read("Dump.md").ends_with("---\nSmall now\n"));
}

/// A record and the file `text` it matches at `Plan.md`, the record's `modifiedAt` being
/// `modified_at`; waits until the file is adopted.
fn matched(text: &str, aliases: &[&str], modified_at: &str) -> (Env, Arc<dyn SecureStore>) {
    let (mut e, store) = opened();
    e.watcher_live();
    pulled_note(&e, "Plan", "Body\n", aliases, modified_at);
    e.write("Plan.md", text);
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Plan.md"));
    assert_eq!(id_at(&e, "Plan.md"), "pulled");
    (e, store)
}

/// Lets a write-back that was owed run, then asserts `Plan.md` still reads `text`.
fn left_as(e: &mut Env, text: &str) {
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.read("Plan.md"), text);
}

const OLDER: &str = "2001-01-01T00:00:00.000Z";

/// VERIFY-5808R3 finding 1 and VERIFY-5808R4 finding 1: an older record keeps its names over a
/// newer file with no `aliases` key and gives the file that key alone, its comment, tags and
/// body as they were; body-only outside edits then keep the names, and push no alias change.
#[test]
fn an_older_record_gives_a_newer_file_with_no_aliases_its_names() {
    let text = "---\n# my note\ntags: ['mine']\n---\nBody\n";
    let (mut e, _store) = matched(text, &["Kept"], OLDER);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Kept"]);
    file_holds(&mut e, "Plan.md", &["Kept"]);
    assert_eq!(
        e.read("Plan.md"),
        "---\n# my note\ntags: ['mine']\naliases:\n  - Kept\n---\nBody\n"
    );

    let text = body_edited(&e, "Plan.md", "Body edited outside\n");
    edited_outside(&mut e, "pulled", "Plan.md", &text);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Kept"]);
    // The first outside edit gives the record the file's tags; the next pushes nothing.
    clear_outbox(&e);
    let text = body_edited(&e, "Plan.md", "Body edited again\n");
    edited_outside(&mut e, "pulled", "Plan.md", &text);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Kept"]);
    assert_eq!(upserts(&e, "pulled"), 0);
}

/// VERIFY-5808R3 finding 2: an explicit `aliases: []` in a newer file is its answer.
#[test]
fn an_older_record_takes_a_newer_files_explicit_empty_aliases() {
    let text = "---\naliases: []\n---\nBody\n";
    let (mut e, _store) = matched(text, &["Stale"], OLDER);
    left_as(&mut e, text);
    assert!(record_aliases(&e, "note", "pulled").is_empty());
}

/// A newer record writes its `aliases` key alone: the file's comment and tags stay.
#[test]
fn a_newer_record_writes_only_its_aliases_into_the_file() {
    let text = "---\n# my note\ntags: ['mine']\naliases: [Old]\n---\nBody\n";
    let (mut e, _store) = matched(text, &["Newer"], NEWER);
    file_holds(&mut e, "Plan.md", &["Newer"]);
    let read = e.read("Plan.md");
    assert!(
        read.starts_with("---\n# my note\ntags: ['mine']\n"),
        "{read}"
    );
    assert!(read.ends_with("---\nBody\n"), "{read}");
    assert_eq!(upserts(&e, "pulled"), 0);

    let text = "---\n# my note\ntags: ['mine']\n---\nBody\n";
    let (mut e, _store) = matched(text, &["Newer"], NEWER);
    file_holds(&mut e, "Plan.md", &["Newer"]);
    let read = e.read("Plan.md");
    assert!(
        read.starts_with("---\n# my note\ntags: ['mine']\n"),
        "{read}"
    );
}

/// VERIFY-5808R3 finding 3: a large file that shrinks with no `aliases` line keeps its tags
/// when the newer record's names are written into it.
#[test]
fn a_large_file_that_shrinks_without_aliases_keeps_its_tags() {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note(&e, "Dump", "", &["Newer"], NEWER);
    let big = "word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1);
    e.write("Dump.md", &format!("---\ntags: [mine]\n---\n{big}"));
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Dump.md"));
    assert_eq!(id_at(&e, "Dump.md"), "pulled");

    e.write("Dump.md", "---\ntags: [mine]\n---\nSmall now\n");
    file_holds(&mut e, "Dump.md", &["Newer"]);
    let read = e.read("Dump.md");
    assert!(read.starts_with("---\ntags: [mine]\n"), "{read}");
    assert!(read.ends_with("---\nSmall now\n"), "{read}");
}
