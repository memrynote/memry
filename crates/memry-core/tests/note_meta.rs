//! A note's tags, properties and aliases, and what a wiki link resolves to.
//!
//! Real SQLite, real payloads written through the domain. No transport.
//!
//! | Test                                              | Rule                                |
//! | ------------------------------------------------- | ----------------------------------- |
//! | tags and properties come back with the note       | chapter 13 §13.7.1                  |
//! | a note with neither is empty, a missing note is nil | empty is not absent               |
//! | an undeclared property is still returned          | never drop what the payload holds   |
//! | properties are ordered by name                    | two reads render the same           |
//! | a wiki link resolves by title, ignoring case      | chapter 12 §12.3                    |
//! | a wiki link falls back to an alias                | same                                |
//! | a link naming nothing is broken, not an error     | `nil` is an answer                  |
//! | a deleted note resolves nothing                   | §7.15                               |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::note_meta;
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn vault(label: &str) -> (Db, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-note-meta-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (
        open_data(&dir.join("data.db")).expect("second open"),
        opened,
    )
}

/// Writes a note through the domain, with whatever tags and properties the
/// test needs. The payload shape is §13.7.1's, written by the same code the
/// app writes with rather than by hand.
fn write_note(
    db: &Db,
    id: &str,
    title: &str,
    tags: &[String],
    properties: Option<Map<String, Value>>,
) {
    db.call_blocking(|conn: &mut Connection| {
        let note = NewNote {
            id,
            title,
            folder_path: None,
            content: "",
            tags,
            properties: properties.as_ref(),
        };
        notes::create(conn, &note, DEVICE, NOW)?;
        Ok(())
    })
    .expect("the write");
}

/// Sets `aliases` directly: nothing in the exported write surface carries them
/// yet, and the resolver has to work against payloads desktop wrote.
fn set_aliases(db: &Db, id: &str, aliases: &[&str]) {
    let json = serde_json::to_string(aliases).expect("the aliases");
    db.call_blocking(|conn: &mut Connection| {
        conn.execute("UPDATE notes SET aliases = ?2 WHERE id = ?1", (id, &json))
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?;
        Ok(())
    })
    .expect("the alias write");
}

fn define_property(db: &Db, name: &str, type_name: &str, color: &str) {
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "INSERT INTO property_definitions (name, type, options, default_value, color) \
             VALUES (?1, ?2, NULL, NULL, ?3)",
            (name, type_name, color),
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        Ok(())
    })
    .expect("the definition");
}

fn metadata(db: &Db, id: &str) -> Option<note_meta::NoteMetadata> {
    db.call_blocking(|conn: &mut Connection| note_meta::metadata(conn, id))
        .expect("the read")
}

fn resolve(db: &Db, target: &str) -> Option<String> {
    db.call_blocking(|conn: &mut Connection| note_meta::resolve_wiki_target(conn, target))
        .expect("the lookup")
}

#[test]
fn tags_and_properties_come_back_with_the_note() {
    let (db, _vault) = vault("full");
    define_property(&db, "Status", "select", "#f97316");
    let properties = json!({ "Status": "Reading", "Pages": 431 })
        .as_object()
        .cloned()
        .expect("an object");
    write_note(
        &db,
        "n1",
        "Dune",
        &["scifi".to_string(), "Café".to_string()],
        Some(properties),
    );

    let read = metadata(&db, "n1").expect("the note");

    // Spelled as written: `Café` and `CAFÉ` are two rows one layer down, and
    // only matching folds case.
    assert_eq!(read.tags, vec!["scifi".to_string(), "Café".to_string()]);
    // Ordered by name, so two reads of an unchanged note render identically.
    assert_eq!(
        read.properties
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Pages", "Status"]
    );
    let status = &read.properties[1];
    assert_eq!(status.value_json, "\"Reading\"");
    assert_eq!(status.type_name.as_deref(), Some("select"));
    assert_eq!(status.color.as_deref(), Some("#f97316"));
    // Undeclared, and still returned: a property written before its definition
    // arrived is legal, and dropping it would lose what the payload holds.
    assert_eq!(read.properties[0].type_name, None);
    assert_eq!(read.properties[0].value_json, "431");
}

#[test]
fn a_bare_note_is_empty_and_a_missing_note_is_nil() {
    // Two different answers for two different facts. A shell that rendered
    // them the same would show a deleted note as a note with no tags.
    let (db, _vault) = vault("bare");
    write_note(&db, "n1", "Plain", &[], None);

    let read = metadata(&db, "n1").expect("the note");
    assert!(read.tags.is_empty());
    assert!(read.properties.is_empty());
    assert!(read.aliases.is_empty());

    assert!(metadata(&db, "no-such-note").is_none());
}

#[test]
fn a_wiki_link_resolves_by_title_ignoring_case() {
    let (db, _vault) = vault("title");
    write_note(&db, "n1", "Dune Messiah", &[], None);

    assert_eq!(resolve(&db, "dune messiah").as_deref(), Some("n1"));
    assert_eq!(resolve(&db, "  Dune Messiah  ").as_deref(), Some("n1"));
}

#[test]
fn a_wiki_link_falls_back_to_an_alias() {
    // Desktop writes aliases; the title pass has to miss before this one runs,
    // or a note titled after another's alias would steal the link.
    let (db, _vault) = vault("alias");
    write_note(&db, "n1", "Frank Herbert", &[], None);
    set_aliases(&db, "n1", &["Herbert", "FH"]);

    assert_eq!(resolve(&db, "herbert").as_deref(), Some("n1"));
    assert_eq!(
        metadata(&db, "n1").expect("the note").aliases,
        vec!["Herbert", "FH"]
    );
}

#[test]
fn a_link_naming_nothing_is_broken_rather_than_an_error() {
    // The broken link is a product state \u2014 desktop offers to create the note \u2014
    // so it has to arrive as an answer, not as a failure to be shown.
    let (db, _vault) = vault("broken");
    write_note(&db, "n1", "Dune", &[], None);

    assert!(resolve(&db, "A note nobody wrote").is_none());
    assert!(resolve(&db, "   ").is_none());
}

#[test]
fn a_deleted_note_resolves_nothing() {
    let (db, _vault) = vault("deleted");
    write_note(&db, "n1", "Dune", &[], None);
    db.call_blocking(|conn: &mut Connection| {
        notes::delete(conn, "n1", DEVICE, NOW)?;
        Ok(())
    })
    .expect("the delete");

    assert!(resolve(&db, "Dune").is_none());
    assert!(metadata(&db, "n1").is_none());
}
