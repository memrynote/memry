//! A note's other names edited in the app (`notes:edit-aliases`, #3530 13q-1) over a real
//! session, tier, watcher and index: the `aliases` key is the only line written, and only when
//! the list changes; the record follows, so a link by the new name resolves; a journal day takes
//! the same edit; a file the note has not taken is refused and left as it is. A change queues one
//! push, a no-op none, and a local-only note none.

use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::aliases::NoteAliasEditInput;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::links::NoteLinks;
use memry_desktop::vault::app_edit::Kept;
use memry_desktop::vault::consumer::ChangeSource;
use memry_desktop::vault::hash::content_hash;

use crate::notes_link_rewrite::{changes, id_at, opened, row_hash};
use crate::vault_env::Env;

const NOTE: &str =
    "---\n# kept as written\ntags: [x]\naliases: [AI]\nstage: Draft\n---\nThe body.\n";

fn edit(id: &str, add: &[&str], remove: &[&str]) -> NoteAliasEditInput {
    let names = |list: &[&str]| list.iter().map(|name| (*name).to_owned()).collect();
    NoteAliasEditInput {
        id: id.to_owned(),
        add: names(add),
        remove: names(remove),
    }
}

/// The aliases the note's synced record carries.
fn record(e: &Env, id: &str) -> Vec<String> {
    e.core()
        .note_files()
        .listed_by_id(id)
        .unwrap()
        .unwrap()
        .aliases
}

/// The record pushes queued for `id`.
fn upserts(e: &Env, id: &str) -> i64 {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE op = 'upsert' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

fn clear_outbox(e: &Env) {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
}

#[test]
fn an_edit_queues_one_push_a_no_op_none_and_a_local_only_note_none() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");

    clear_outbox(&e);
    notes
        .edit_aliases(&open, &edit(&id, &["Other"], &[]))
        .unwrap();
    assert_eq!(upserts(&e, &id), 1);

    clear_outbox(&e);
    notes
        .edit_aliases(&open, &edit(&id, &["other"], &[]))
        .unwrap();
    assert_eq!(
        upserts(&e, &id),
        0,
        "a list the record holds queues nothing"
    );

    e.core().note_files().set_local_only(&id, true).unwrap();
    clear_outbox(&e);
    notes
        .edit_aliases(&open, &edit(&id, &["Third"], &[]))
        .unwrap();
    assert!(e.read("Plan.md").contains("  - Third\n"));
    assert_eq!(upserts(&e, &id), 0, "a local-only note stays off the queue");
}

#[test]
fn an_edit_writes_only_the_aliases_line_and_the_record_follows() {
    let (mut e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    e.drain();

    let edited = notes
        .edit_aliases(&open, &edit(&id, &[" A.I. ", "plan", "a.i."], &["ai"]))
        .unwrap();
    assert_eq!(
        edited.aliases,
        ["A.I."],
        "removed by name key, the title is no alias"
    );
    let expected = "---\n# kept as written\ntags: [x]\naliases:\n  - A.I.\nstage: Draft\n---\n\
The body.\n";
    assert_eq!(e.read("Plan.md"), expected);
    assert_eq!(record(&e, &id), ["A.I."]);
    assert_eq!(e.body(&id), "The body.");
    assert_eq!(row_hash(&e, &id), Some(content_hash(expected)));
    assert_eq!(
        changes(&mut e),
        [("Plan.md".to_owned(), ChangeSource::AppEdit)]
    );
    let resolved = NoteLinks::new(&open).resolve_by_title("a.i.").unwrap();
    assert_eq!(resolved.map(|link| link.id), Some(id.clone()));

    // A name the list already holds, spelled another way: nothing to write.
    let same = notes
        .edit_aliases(&open, &edit(&id, &["a.i."], &[]))
        .unwrap();
    assert_eq!(same.aliases, ["A.I."]);
    assert_eq!(e.read("Plan.md"), expected);
    assert!(changes(&mut e).is_empty());
}

/// Electron writes the key only when the normalized list changes, so a list spelled the user's
/// way (a repeat, a lone value, the title among them) keeps its bytes until it does.
#[test]
fn an_edit_that_leaves_the_list_keeps_the_files_spelling() {
    let text = "---\naliases: [AI, ai, Plan]\n---\nThe body.\n";
    let (mut e, notes, _) = opened(&[("Plan.md", text)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    e.drain();
    let edited = notes
        .edit_aliases(&open, &edit(&id, &["ai", "plan"], &["gone"]))
        .unwrap();
    assert_eq!(edited.aliases, ["AI"]);
    assert_eq!(e.read("Plan.md"), text);
    assert!(changes(&mut e).is_empty());
}

#[test]
fn the_last_name_removed_takes_the_key_with_it() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes
        .edit_aliases(&open, &edit(&id, &["Other"], &[]))
        .unwrap();
    assert_eq!(record(&e, &id), ["AI", "Other"]);

    let edited = notes
        .edit_aliases(&open, &edit(&id, &[], &["ai", "OTHER"]))
        .unwrap();
    assert!(edited.aliases.is_empty());
    assert_eq!(
        e.read("Plan.md"),
        "---\n# kept as written\ntags: [x]\nstage: Draft\n---\nThe body.\n"
    );
    assert!(record(&e, &id).is_empty());
}

#[test]
fn a_journal_day_takes_the_edit_with_its_date_as_the_title() {
    let (e, notes, store) = opened(&[]);
    let open = e.session.current().unwrap();
    let date = "2025-03-06";
    let day = NewDay {
        date: date.into(),
        content: "Made in the app.".into(),
        ..NewDay::default()
    };
    let id = notes.create_day(&open, day).unwrap().id;
    let rel = format!("journal/{date}.md");
    crate::index_support::until("the day's row names its file", || {
        row_hash(&e, &id) == Some(content_hash(&e.read(&rel)))
    });

    let edited = notes
        .edit_aliases(&open, &edit(&id, &["Launch", date], &[]))
        .unwrap();
    assert_eq!(edited.aliases, ["Launch"]);
    assert!(
        e.read(&rel).contains("aliases:\n  - Launch\n"),
        "{}",
        e.read(&rel)
    );
    let journal = e.core().journal(store).unwrap();
    let stored = journal.day(date.to_owned()).unwrap().unwrap();
    assert_eq!(stored.aliases, ["Launch"]);
}

#[test]
fn a_file_the_note_has_not_taken_is_refused_and_left_as_it_is() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    e.core()
        .note_files()
        .set_hash(&id, Some("not-the-file"))
        .unwrap();
    let edited = notes.edit_aliases(&open, &edit(&id, &["Other"], &[]));
    assert!(matches!(
        edited,
        Err(NotesError::EditKept(Kept::FileChanged))
    ));
    assert_eq!(e.read("Plan.md"), NOTE);
    assert!(!record(&e, &id).contains(&"Other".to_owned()));
}

#[test]
fn too_many_or_too_long_names_are_refused_before_the_file_is_read() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let long = "x".repeat(201);
    let many: Vec<String> = (0..33).map(|n| format!("n{n}")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    for input in [edit(&id, &[&long], &[]), edit(&id, &[], &many)] {
        assert!(matches!(
            notes.edit_aliases(&open, &input),
            Err(NotesError::InvalidAliases)
        ));
    }
    assert_eq!(e.read("Plan.md"), NOTE);
}
