//! OL-F14 (#5738): a `note_properties` row marked `yaml_string` (index 0038) was a string in the
//! file. The imported record keeps it a string, so a frontmatter written from the record keeps a
//! quoted `'2024-01-02'`, `'[1,2]'` or `'true'` quoted. A 0037 index has no column and reads as
//! Electron's push reads it.

use memry_core::markdown::frontmatter::{json_to_yaml, safe_dump, safe_load};
use rusqlite::Connection;
use rusqlite::types::Value;
use serde_json::json;

use super::ledger_ends::index_at;
use super::notes::{installed, payload};
use super::{Vault, electron_db, import};

const ID: &str = "Quoted00001a";
const HEADER: &str = "when: '2024-01-02'\nids: '[1,2]'\ndone: 'true'\nlist:\n  - 1\n  - 2\n";

/// `(name, value, type, yaml_string)` as Electron indexes [`HEADER`].
const ROWS: &[(&str, &str, &str, i64)] = &[
    ("when", "2024-01-02", "date", 1),
    ("ids", "[1,2]", "multiselect", 1),
    ("done", "true", "checkbox", 1),
    ("list", "[1,2]", "multiselect", 0),
];

/// Imports one note whose index rows are [`ROWS`], and returns the record's properties.
fn imported_properties(vault: &Vault, yaml_string: bool) -> serde_json::Value {
    std::fs::write(
        vault.root.join("Quoted.md"),
        format!("---\n{HEADER}---\nBody\n"),
    )
    .unwrap();
    electron_db::seed(
        &vault.data_conn(),
        "note_metadata",
        &[
            ("id", Value::Text(ID.into())),
            ("path", Value::Text("Quoted.md".into())),
            ("title", Value::Text("Quoted".into())),
            ("file_type", Value::Text("markdown".into())),
            ("local_only", Value::Integer(0)),
            ("clock", Value::Text(r#"{"dev-A":1}"#.into())),
            ("created_at", Value::Text("2026-01-02T03:04:05.000Z".into())),
            (
                "modified_at",
                Value::Text("2026-01-03T03:04:05.000Z".into()),
            ),
        ],
    );
    let index = Connection::open(&vault.pair.index).unwrap();
    electron_db::seed(&index, "note_cache", &[("id", Value::Text(ID.into()))]);
    for &(name, value, kind, mark) in ROWS {
        let mut row = vec![
            ("note_id", Value::Text(ID.into())),
            ("name", Value::Text(name.into())),
            ("value", Value::Text(value.into())),
            ("type", Value::Text(kind.into())),
        ];
        if yaml_string {
            row.push(("yaml_string", Value::Integer(mark)));
        }
        electron_db::seed(&index, "note_properties", &row);
    }
    drop(index);
    import(vault);
    let record: serde_json::Value =
        serde_json::from_str(&payload(&installed(vault), "note", ID)).unwrap();
    record["properties"].clone()
}

#[test]
fn a_quoted_string_marked_yaml_string_imports_as_the_string() {
    let vault = Vault::new();
    let properties = imported_properties(&vault, true);

    assert_eq!(
        properties,
        json!({ "when": "2024-01-02", "ids": "[1,2]", "done": "true", "list": [1, 2] })
    );
    // A frontmatter written from the record is the one the file held.
    let written = safe_dump(&json_to_yaml(&properties)).unwrap();
    assert_eq!(safe_load(&written).unwrap(), safe_load(HEADER).unwrap());
}

#[test]
fn an_index_without_yaml_string_imports_as_electrons_push() {
    let vault = Vault::new();
    index_at(&vault, "0037_note_pending_write_hash");

    assert_eq!(
        imported_properties(&vault, false),
        json!({ "when": "2024-01-02", "ids": [1, 2], "done": true, "list": [1, 2] })
    );
}
