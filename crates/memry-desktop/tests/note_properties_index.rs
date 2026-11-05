//! The note index fills `note_properties` (#3530 13k-4b) as Electron's `setNoteProperties`
//! does, over a real session, tier, watcher and index task: a row per user property with its
//! `serializeValue` text and its type, the definitions read from `properties.md` and the
//! records.
//!
//! | Test                                                        | Rule                               |
//! | ----------------------------------------------------------- | ---------------------------------- |
//! | a note's properties are indexed as Electron's index holds them | `setNoteProperties`, `extractProperties` |
//! | an outside edit and a removal keep the rows current          | the rows follow the file           |
//! | a definition's new type retypes the rows holding it          | `retypeIndexedProperties`          |
//! | an index from before the rows were filled fills them         | derived rows rebuild at the open   |
//! | a note that turns large or cannot be read loses its rows     | `note.properties ?? {}`            |
//! | an unreadable note does not hold back the types' record      | `retypeIndexedProperties` skips it |
//! | definitions that do not read type no row                     | no row typed by guesses            |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::path::Path;
use std::sync::Arc;

use index_support::{until, with_task_under};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IDLE_DELAY, NoteIndex};
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionType, PropertyDefinitions,
};
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::hash::content_hash;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

const DEFINITIONS: &str = "---\nproperties:\n  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  due:\n    type: text\n---\n";

const NOTE: &str = "---\ntags: [work]\naliases: [Plan]\nstage: Draft\nrating: 5\ndone: true\ndue: 2024-01-02\nsite: https://example.com\nlist: [a, b]\nempty:\n---\n# Plan\n";

type Row = (String, Option<String>, String);

fn row(name: &str, text: Option<&str>, type_name: &str) -> Row {
    (
        name.to_owned(),
        text.map(str::to_owned),
        type_name.to_owned(),
    )
}

/// The note's `note_properties` rows, read from `index.db` as any reader of the table does.
fn rows(vault: &Path, note_id: &str) -> Vec<Row> {
    let index = rusqlite::Connection::open(vault.join(".memry/core/index.db")).unwrap();
    let mut statement = index
        .prepare("SELECT name, value, type FROM note_properties WHERE note_id = ?1 ORDER BY rowid")
        .unwrap();
    statement
        .query_map([note_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// A vault holding `Plan.md` and the definitions, opened with its index running.
fn opened() -> (Env, Arc<NoteIndex>, String) {
    opened_with(&[])
}

/// [`opened`], with `others` beside `Plan.md`.
fn opened_with(others: &[(&str, &str)]) -> (Env, Arc<NoteIndex>, String) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write(".memry/properties.md", DEFINITIONS);
    e.write("Plan.md", NOTE);
    for (path, text) in others {
        e.write(path, text);
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let id = e
        .rows()
        .into_iter()
        .find(|(_, path)| path == "Plan.md")
        .unwrap()
        .0;
    (e, index, id)
}

fn id_at(e: &Env, path: &str) -> String {
    e.rows().into_iter().find(|(_, p)| p == path).unwrap().0
}

/// Waits until the index read `text` for the note at `path`.
fn read(e: &Env, path: &str, text: &str) {
    let id = id_at(e, path);
    let search = e.session.current().unwrap().search;
    until("the file read", || {
        let stored = search.note_stats(&id).unwrap();
        stored.and_then(|stored| stored.file_hash) == Some(content_hash(text))
    });
}

fn indexed_at(vault: &Path, note_id: &str) -> i64 {
    let index = rusqlite::Connection::open(vault.join(".memry/core/index.db")).unwrap();
    index
        .query_row(
            "SELECT indexed_at FROM note_stats WHERE note_id = ?1",
            [note_id],
            |r| r.get(0),
        )
        .unwrap()
}

fn typed_with(e: &Env) -> bool {
    let search = e.session.current().unwrap().search;
    search.properties_typed_with().unwrap().is_some()
}

fn indexed_plan() -> Vec<Row> {
    vec![
        row("stage", Some("Draft"), "select"),
        row("rating", Some("5"), "number"),
        row("done", Some("true"), "checkbox"),
        // An unquoted YAML date under a `text` definition stays a date (BBF-43).
        row("due", Some("2024-01-02"), "date"),
        row("site", Some("https://example.com"), "url"),
        row("list", Some(r#"["a","b"]"#), "text"),
        row("empty", None, "text"),
    ]
}

#[test]
fn a_notes_properties_are_indexed_as_electrons_index_holds_them() {
    let (mut e, _index, id) = opened();
    until("the note's properties indexed", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    e.close();
}

#[test]
fn an_outside_edit_and_a_removal_keep_the_rows_current() {
    let (mut e, _index, id) = opened();
    until("the note's properties indexed", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    e.write("Plan.md", "---\nrating: 6\n---\n# Plan\n");
    until("the outside edit indexed", || {
        rows(&e.vault, &id) == [row("rating", Some("6"), "number")]
    });
    // A frontmatter that does not parse holds no properties (`parseNote` reads none).
    e.write("Plan.md", "---\nrating: [\n---\n# Plan\n");
    until("the broken frontmatter indexed", || {
        rows(&e.vault, &id).is_empty()
    });
    e.write("Plan.md", "---\nrating: 7\n---\n# Plan\n");
    until("the edit indexed", || !rows(&e.vault, &id).is_empty());
    std::fs::remove_file(e.vault.join("Plan.md")).unwrap();
    until("the removed note's rows dropped", || {
        rows(&e.vault, &id).is_empty()
    });
    e.close();
}

#[test]
fn a_definitions_new_type_retypes_the_rows_holding_it() {
    let (mut e, index, id) = opened();
    until("the note's properties indexed", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    let open = e.session.current().unwrap();
    let definitions = PropertyDefinitions::open(&open, e.tier.store()).unwrap();
    let input = DefinitionInput {
        name: "rating".into(),
        type_name: Some(DefinitionType::Text),
        options: None,
        default_value: None,
        color: None,
    };
    definitions.create(input).unwrap();
    // As every definition command does once it ran.
    index.retype();
    until("the row retyped", || {
        rows(&e.vault, &id).contains(&row("rating", Some("5"), "text"))
    });
    drop(open);
    e.close();
}

#[test]
fn an_index_from_before_the_rows_were_filled_fills_them_at_the_open() {
    let (mut e, _index, id) = opened();
    until("the note's properties indexed", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    e.close();
    // As an index built before 13k-4b leaves it: current rows, no property rows.
    rusqlite::Connection::open(e.vault.join(".memry/core/index.db"))
        .unwrap()
        .execute_batch(
            "DELETE FROM note_properties;
             DELETE FROM index_meta WHERE key = 'note_properties.typed_with';",
        )
        .unwrap();
    e.open();
    until("the rows filled again", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    e.close();
}

#[test]
fn a_note_that_turns_large_or_cannot_be_read_loses_its_rows() {
    let (mut e, index, id) = opened_with(&[("Other.md", "---\nrating: 1\n---\n")]);
    let other = id_at(&e, "Other.md");
    until("both notes' properties indexed", || {
        rows(&e.vault, &id) == indexed_plan() && !rows(&e.vault, &other).is_empty()
    });
    let large = format!("{NOTE}{}\n", "x".repeat(130 * 1024));
    e.write("Plan.md", &large);
    // No fact tells of a note turning large; a reindex reads it.
    index.reindex(|_| {}).unwrap();
    assert!(rows(&e.vault, &id).is_empty());
    // Linked: the index refuses to read it, and it is owed to the next pass.
    std::fs::hard_link(e.vault.join("Other.md"), e._dir.path().join("linked.md")).unwrap();
    let done = index.reindex(|_| {}).unwrap();
    assert_eq!(done.unread, 1);
    assert!(rows(&e.vault, &other).is_empty());
    e.close();
}

#[test]
fn an_unreadable_note_does_not_hold_back_the_record_of_the_types() {
    let third = "---\nrating: 3\n---\n";
    let (mut e, _index, id) = opened_with(&[("Other.md", "Other\n"), ("Third.md", third)]);
    until("the note's properties indexed", || {
        rows(&e.vault, &id) == indexed_plan()
    });
    e.close();
    std::fs::hard_link(e.vault.join("Other.md"), e._dir.path().join("linked.md")).unwrap();
    rusqlite::Connection::open(e.vault.join(".memry/core/index.db"))
        .unwrap()
        .execute_batch(
            "DELETE FROM note_properties;
             DELETE FROM index_meta WHERE key = 'note_properties.typed_with';",
        )
        .unwrap();
    e.open();
    until("the types recorded", || typed_with(&e));
    assert_eq!(rows(&e.vault, &id), indexed_plan());
    // An edit of another note reads that note alone.
    let before = indexed_at(&e.vault, &id);
    let edited = "---\nrating: 4\n---\n";
    e.write("Third.md", edited);
    read(&e, "Third.md", edited);
    assert_eq!(indexed_at(&e.vault, &id), before);
    e.close();
}

/// The definitions' records open under the device key: a task with none cannot read them.
#[test]
fn definitions_that_do_not_read_type_no_row() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write(".memry/properties.md", DEFINITIONS);
    e.write("Plan.md", NOTE);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let (sender, receiver) = broadcast::channel(16);
    let report = |_| {};
    with_task_under(
        &open,
        receiver,
        device_key::without_device_key(),
        &report,
        |_| {
            sender.send(Applied::Indexed { complete: true }).unwrap();
            // The open's pass ran, and was owed again.
            std::thread::sleep(IDLE_DELAY * 2);
            assert!(open.search.note_stats(&id).unwrap().is_none());
            assert!(rows(&e.vault, &id).is_empty());
            assert!(!typed_with(&e));
        },
    );
    drop(open);
    e.close();
}
