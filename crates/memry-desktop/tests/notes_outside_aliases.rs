//! An edit outside the app to a file's frontmatter `aliases:` reaching its record (#5599), under
//! the running vault tier with `NotesIdentity`: the record of a note or a journal day takes the
//! file's list whole, as desktop's watcher does (`extractAliases`, `vault/note-sync.ts` and
//! `vault/journal.ts`), so the next push carries it and a pull of that record keeps it.

use memry_core::markdown::shared::markdown_class::NOTE_MAX_BYTES;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;

use crate::index_support::until;
use crate::notes_outside_tags::{clear_outbox, edited_outside, opened, upserts};
use crate::vault_env::{Env, QUIET, env, indexed};

/// The record's `aliases`, as its payload holds them.
fn record_aliases(e: &Env, item_type: &'static str, id: &str) -> Vec<String> {
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
fn id_at(e: &Env, rel: &str) -> String {
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

/// A pulled note no row names, whose body the file matches (`Adopted::Existing`), with
/// `aliases` and a `modifiedAt`.
fn pulled_plan(e: &Env, aliases: &[&str], modified_at: &str) {
    let record = InboundRecord {
        item_type: "note".to_owned(),
        item_id: "pulled".to_owned(),
        payload_json: serde_json::json!({
            "title": "Plan",
            "content": "Body\n",
            "fileType": "markdown",
            "folderPath": null,
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

/// `Plan.md` written with `aliases: [FromFile]` over a pulled record whose `modifiedAt` is
/// `modified_at`, matched by the file (`Adopted::Existing`).
fn adopted_plan(modified_at: &str, aliases: &[&str]) -> Env {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_plan(&e, aliases, modified_at);
    e.write("Plan.md", "---\naliases: [FromFile]\n---\nBody\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Plan.md"));
    assert_eq!(id_at(&e, "Plan.md"), "pulled");
    e
}

/// A record modified after the file that matched it keeps its own aliases (#5423).
#[test]
fn a_matched_record_newer_than_its_file_keeps_its_aliases() {
    let e = adopted_plan("2999-01-01T00:00:00.000Z", &["Newer"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
}

/// A record modified before the file that matched it takes the file's aliases (#5423).
#[test]
fn a_matched_record_older_than_its_file_takes_its_aliases() {
    let e = adopted_plan("2001-01-01T00:00:00.000Z", &["Older"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["FromFile"]);
}

/// The newer record kept its aliases over the file's stale list (REVIEW-5808): an outside edit
/// that leaves the file's list as it was pushes no record and keeps the record's names, and one
/// that changes the list is taken.
#[test]
fn an_outside_edit_keeps_a_newer_matched_records_aliases_until_the_files_list_changes() {
    let mut e = adopted_plan("2999-01-01T00:00:00.000Z", &["Newer"]);
    std::thread::sleep(QUIET);
    e.drain();

    clear_outbox(&e);
    edited_outside(
        &mut e,
        "pulled",
        "Plan.md",
        "---\naliases: [FromFile]\n---\nBody edited outside\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert_eq!(upserts(&e, "pulled"), 0);

    clear_outbox(&e);
    edited_outside(
        &mut e,
        "pulled",
        "Plan.md",
        "---\naliases: [FromFile]\n---\nBody edited outside, again\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert_eq!(upserts(&e, "pulled"), 0);

    clear_outbox(&e);
    edited_outside(
        &mut e,
        "pulled",
        "Plan.md",
        "---\naliases: [Renamed]\n---\nBody edited outside, again\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Renamed"]);
    assert_eq!(upserts(&e, "pulled"), 1);
}
