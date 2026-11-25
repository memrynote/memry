//! An edit outside the app to a file's frontmatter `aliases:` reaching its record (#5599), under
//! the running vault tier with `NotesIdentity`: the record of a note or a journal day takes the
//! file's list whole, as desktop's watcher does (`extractAliases`, `vault/note-sync.ts` and
//! `vault/journal.ts`), so the next push carries it and a pull of that record keeps it.

use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;

use crate::notes_outside_tags::{clear_outbox, edited_outside, opened, upserts};
use crate::vault_env::{Env, QUIET};

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
