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

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::path::Path;
use std::sync::Arc;

use index_support::until;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionType, PropertyDefinitions,
};
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
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write(".memry/properties.md", DEFINITIONS);
    e.write("Plan.md", NOTE);
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
