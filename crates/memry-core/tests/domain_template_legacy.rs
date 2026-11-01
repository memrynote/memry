//! The pre-sync template files' parse and insert on real SQLite (desktop Step 13l, #3530),
//! after desktop `vault/templates-migration.ts`. The whole import over files Electron wrote is
//! `memry-desktop/tests/templates_legacy.rs`.
//!
//! | Test                                                         | Rule                                 |
//! | ------------------------------------------------------------ | ------------------------------------ |
//! | a file reads as `parseTemplate` reads it                     | id from the name, trimmed body       |
//! | a built-in by flag or by id is never a template              | `isBuiltIn`, `BUILT_IN_IDS`          |
//! | a value the insert would refuse refuses the file             | the driver binds no boolean or list  |
//! | numbers read as SQLite stored Electron's, dates as ISO text  | text affinity; a kept unquoted date  |
//! | an id the database ever held is never written again         | `onConflictDoNothing`, no resurrect  |
//! | the flag is set once and stays                               | `templates.importedFromFiles`        |

#![cfg(feature = "markdown")]

use memry_core::api::errors::StorageError;
use memry_core::domain::template_legacy::{self, LegacyTemplate, Parsed};
use memry_core::domain::template_store;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: &str = "2026-01-02T03:04:05.000Z";
const NOW_MS: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn template(stem: &str, file: &str) -> LegacyTemplate {
    match template_legacy::parse(stem, file, NOW) {
        Parsed::Template(template) => template,
        other => panic!("{stem}: {other:?}"),
    }
}

fn refused(stem: &str, file: &str) -> String {
    match template_legacy::parse(stem, file, NOW) {
        Parsed::Refused(why) => why,
        other => panic!("{stem}: {other:?}"),
    }
}

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-template-legacy-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

#[test]
fn a_file_reads_as_parse_template_reads_it() {
    let read = template(
        "from-name",
        "\u{feff}---\nname: Standup\ndescription: Daily\nicon: S\ntags: [a, A, b]\n\
         properties:\n  - name: due\n    type: date\n    value: null\n---\n\n  ## Body\n\n",
    );
    assert_eq!(
        read,
        LegacyTemplate {
            id: "from-name".into(),
            name: "Standup".into(),
            description: Some("Daily".into()),
            icon: Some("S".into()),
            tags: vec!["a".into(), "b".into()],
            properties: vec![json!({ "name": "due", "type": "date", "value": null })],
            content: "## Body".into(),
            created_at: NOW.into(),
            modified_at: NOW.into(),
        }
    );

    // No frontmatter: the name is the id, the whole text the body. An unclosed block runs to
    // the end and leaves no body, as in gray-matter.
    let bare = template("bare", "  just text\n");
    assert_eq!(
        (bare.name.as_str(), bare.content.as_str()),
        ("bare", "just text")
    );
    let unclosed = template("open", "---\nname: Open\n");
    assert_eq!(
        (unclosed.name.as_str(), unclosed.content.as_str()),
        ("Open", "")
    );
    // Frontmatter that is not a map has no fields.
    assert_eq!(template("listed", "---\n- a\n---\nx").name, "listed");
}

#[test]
fn a_built_in_by_flag_or_by_id_is_never_a_template() {
    let parse = |stem: &str, file: &str| template_legacy::parse(stem, file, NOW);
    assert_eq!(
        parse("mine", "---\nisBuiltIn: true\n---\n"),
        Parsed::BuiltIn
    );
    assert_eq!(parse("x", "---\nid: blank\n---\n"), Parsed::BuiltIn);
    // Only `true` is the flag.
    assert!(matches!(
        parse("mine", "---\nisBuiltIn: 'true'\n---\n"),
        Parsed::Template(_)
    ));
}

#[test]
fn a_value_the_insert_would_refuse_refuses_the_file() {
    assert!(refused("x", "---\nname: [unclosed\n---\n").starts_with("frontmatter"));
    assert_eq!(refused("x", "---\nname: true\n---\n"), "`name` is not text");
    assert_eq!(refused("x", "---\nicon: [a]\n---\n"), "`icon` is not text");
    assert_eq!(refused("x", "---\nid: ''\n---\n"), "the id is empty");
}

#[test]
fn numbers_read_as_sqlite_stored_electrons_and_dates_as_iso_text() {
    let read = template(
        "n",
        "---\nid: 42\nname: 2024\ndescription: 1.5\ntags: [7, true, null]\n\
         createdAt: 2024-05-06T07:08:09Z\nproperties:\n  - name: due\n    value: 2024-05-06\n---\n",
    );
    assert_eq!(read.id, "42.0");
    assert_eq!(read.name, "2024.0");
    assert_eq!(read.description.as_deref(), Some("1.5"));
    assert_eq!(read.tags, ["7", "true"]);
    assert_eq!(read.created_at, "2024-05-06T07:08:09.000Z");
    assert_eq!(read.modified_at, NOW);
    assert_eq!(
        read.properties,
        [json!({ "name": "due", "value": "2024-05-06T00:00:00.000Z" })]
    );
}

#[test]
fn an_id_the_database_ever_held_is_never_written_again() {
    let db = open("ids");
    let (first, again, payload, after_delete) = run(&db, |conn| {
        let file = template(
            "legacy1",
            "---\nname: Legacy\ncreatedAt: '2025-01-01T00:00:00.000Z'\n---\nBody",
        );
        let first = template_legacy::import(conn, &file, DEVICE, NOW_MS)?;
        let again = template_legacy::import(conn, &file, DEVICE, NOW_MS + 1)?;
        let raw = sync_items::push_payload(conn, "template", "legacy1")?.expect("a payload");
        let payload: Value = serde_json::from_str(&raw).expect("JSON");
        template_store::delete(conn, "legacy1", DEVICE, NOW_MS + 2)?;
        let after_delete = template_legacy::import(conn, &file, DEVICE, NOW_MS + 3)?;
        Ok((first, again, payload, after_delete))
    });
    assert!(first);
    assert!(!again, "a live id is left alone");
    assert!(!after_delete, "a deleted id is not brought back");
    assert_eq!(payload["name"], "Legacy");
    assert_eq!(payload["content"], "Body");
    assert_eq!(payload["createdAt"], "2025-01-01T00:00:00.000Z");
    assert_eq!(payload["modifiedAt"], NOW);
    assert!(
        payload["clock"].is_object(),
        "a clock, so the push carries it"
    );
    let live = run(&db, |conn| template_store::get(conn, "legacy1"));
    assert_eq!(live, None);
}

#[test]
fn the_flag_is_set_once_and_stays() {
    let db = open("flag");
    let (before, after, twice) = run(&db, |conn| {
        let before = template_legacy::imported(conn)?;
        template_legacy::mark_imported(conn)?;
        let after = template_legacy::imported(conn)?;
        template_legacy::mark_imported(conn)?;
        Ok((before, after, template_legacy::imported(conn)?))
    });
    assert_eq!((before, after, twice), (false, true, true));
}
