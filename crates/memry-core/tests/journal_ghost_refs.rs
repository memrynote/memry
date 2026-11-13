//! The references of a journal day not written yet (#4409, Electron's `getIncomingReferences`):
//! the links left unresolved under its date and the relations naming it, through
//! `link_reads::incoming` on real migrated databases, and `property_refs` filled from the rows an
//! index migrated in place already holds.
//!
//! | Test                                              | Rule                                    |
//! | ------------------------------------------------- | --------------------------------------- |
//! | an unwritten day lists a link, then a relation    | ghost references, links first           |
//! | a date off the calendar lists nothing             | `j2026-02-30` is no day                 |
//! | a date another note is titled lists nothing       | the date names that note, not the day   |
//! | an index migrated in place fills `property_refs`  | migration 0009 reads `note_properties`  |

use memry_core::domain::link_reads;
use memry_core::domain::notes::names::name_key;
use memry_core::domain::wiki_target::settle_name_keys;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::{Connection, params};

fn dbs() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn note(data: &Connection, id: &str, title: &str) {
    data.execute(
        "INSERT INTO notes (id, title, file_type, created_at, modified_at) \
         VALUES (?1, ?2, 'markdown', 1, 1)",
        params![id, title],
    )
    .expect("note");
}

/// A link the index could not resolve, as it stores one: no target, keyed by the name.
fn unresolved(index: &Connection, source: &str, title: &str) {
    index
        .execute(
            "INSERT INTO note_links (source_id, target_id, target_title, target_key) \
             VALUES (?1, NULL, ?2, ?3)",
            params![source, title, name_key(title)],
        )
        .expect("link");
}

/// A relation property as the note index writes it.
fn relation(index: &Connection, source: &str, name: &str, kind: &str, id: &str) {
    index
        .execute(
            "INSERT INTO note_properties (note_id, name, value, type) VALUES (?1, ?2, ?3, 'relation')",
            params![source, name, format!("[\"memry://{kind}/{id}\"]")],
        )
        .expect("property row");
    index
        .execute(
            "INSERT INTO property_refs (source_id, name, target_type, target_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![source, name, kind, id],
        )
        .expect("relation row");
}

fn sources(data: &Connection, index: &Connection, id: &str) -> Vec<(String, Option<String>)> {
    link_reads::incoming(data, index, id)
        .expect("incoming")
        .sources
        .into_iter()
        .map(|source| (source.source_id, source.via_property))
        .collect()
}

#[test]
fn an_unwritten_day_lists_a_link_then_a_relation() {
    let (data, index) = dbs();
    note(&data, "a", "Observation");
    note(&data, "b", "Plan");
    unresolved(&index, "a", "2026-05-08");
    relation(&index, "b", "related", "journal", "2026-05-08");
    relation(&index, "a", "other", "journal", "2026-05-07");

    assert_eq!(
        sources(&data, &index, "j2026-05-08"),
        [
            ("a".to_owned(), None),
            ("b".to_owned(), Some("related".to_owned()))
        ]
    );
    let titled = link_reads::incoming(&data, &index, "j2026-05-08").expect("incoming");
    assert_eq!(titled.target_title.as_deref(), Some("2026-05-08"));
}

#[test]
fn a_date_off_the_calendar_lists_nothing() {
    let (data, index) = dbs();
    note(&data, "a", "Observation");
    unresolved(&index, "a", "2026-02-30");
    assert!(sources(&data, &index, "j2026-02-30").is_empty());
}

#[test]
fn a_date_another_note_is_titled_lists_nothing() {
    let (data, index) = dbs();
    note(&data, "a", "Observation");
    note(&data, "d", "2026-05-09");
    settle_name_keys(&data).expect("settle");
    // A row the index left unresolved before the note took the date's name.
    unresolved(&index, "a", "2026-05-09");
    assert!(sources(&data, &index, "j2026-05-09").is_empty());
}

#[test]
fn an_index_migrated_in_place_fills_property_refs_from_its_rows() {
    let mut index = Connection::open_in_memory().expect("index.db");
    let before = INDEX_MIGRATIONS
        .iter()
        .position(|migration| migration.name == "property_refs")
        .expect("the migration");
    migrations::run(&mut index, &INDEX_MIGRATIONS[..before]).expect("older migrations");
    let row = |note: &str, name: &str, value: &str| {
        index
            .execute(
                "INSERT INTO note_properties (note_id, name, value, type) VALUES (?1, ?2, ?3, 'relation')",
                params![note, name, value],
            )
            .expect("property row");
    };
    row(
        "a",
        "related",
        r#"["memry://journal/2026-05-08","memry://note/n1","memry://note/n1"]"#,
    );
    // A list with one item that is not a relation URI is no relation at all.
    row("b", "mixed", r#"["memry://note/n1","plain"]"#);
    row("c", "day", r#"["memry://journal/May-8"]"#);
    row("d", "bad", r#"["memry://note/a b"]"#);
    row("e", "text", "memry://note/n1");
    row("f", "empty", "[]");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("the migration");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("again");

    let mut statement = index
        .prepare(
            "SELECT source_id, name, target_type, target_id FROM property_refs \
             ORDER BY source_id, target_type, target_id",
        )
        .expect("read");
    let refs: Vec<(String, String, String, String)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("rows");
    let own = |a: &str, b: &str, c: &str, d: &str| (a.into(), b.into(), c.into(), d.into());
    assert_eq!(
        refs,
        [
            own("a", "related", "journal", "2026-05-08"),
            own("a", "related", "note", "n1"),
        ]
    );
}
