//! An edit outside the app to a file's frontmatter `aliases:` reaching its record (#5599), under
//! the running vault tier with `NotesIdentity`: the record of a note or a journal day takes the
//! file's list whole, as desktop's watcher does (`extractAliases`, `vault/note-sync.ts` and
//! `vault/journal.ts`), so the next push carries it and a pull of that record keeps it.

use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;

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
