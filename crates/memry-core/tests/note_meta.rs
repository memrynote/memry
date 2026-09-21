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

// MARK: - Property writes (N700)

/// The ten property types §13.7.1 allows, each written and read back.
///
/// **One call serves all ten** because the value crosses as JSON text rather
/// than a typed union: §13.7.1 lets a property hold any JSON, and a closed
/// enum would have to drop or coerce whatever did not fit.
#[test]
fn every_property_type_survives_a_write_and_a_read() {
    let (db, _vault) = vault("property-types");
    write_note(&db, "note-1", "A note", &[], None);

    let cases: Vec<(&str, Value)> = vec![
        ("text", json!("a sentence")),
        ("number", json!(42)),
        ("date", json!("2026-09-22")),
        ("checkbox", json!(true)),
        ("url", json!("https://memry.app")),
        ("status", json!("in progress")),
        ("select", json!("one")),
        ("multiselect", json!(["one", "two"])),
        ("relation", json!(["note-2"])),
        ("project", json!("project-1")),
    ];

    for (name, value) in &cases {
        db.call_blocking({
            let name = (*name).to_owned();
            let value = value.clone();
            move |conn: &mut Connection| {
                memry_core::domain::properties::set(
                    conn, "note", "note-1", &name, value, DEVICE, NOW,
                )
                .expect("the property write");
                Ok(())
            }
        })
        .expect("the write");
    }

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");

    for (name, value) in &cases {
        let stored = metadata
            .properties
            .iter()
            .find(|property| property.name == *name)
            .unwrap_or_else(|| panic!("{name} is missing"));
        let parsed: Value =
            serde_json::from_str(&stored.value_json).expect("the stored value is JSON");
        assert_eq!(&parsed, value, "{name} did not round-trip");
    }
}

/// **FR-048: a value edit never retypes a property.**
///
/// The refusal is typed rather than folded into a storage failure because a
/// surface has to tell "that is not a valid value for this property" from
/// "the disk is full" — and a silent coercion would be invisible at the call
/// site and permanent on the wire, since the merged payload is what every
/// other device then reads.
#[test]
fn changing_a_propertys_type_is_refused_rather_than_coerced() {
    use memry_core::domain::properties::{self, PropertyError};

    let (db, _vault) = vault("property-retype");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        properties::set(conn, "note", "note-1", "count", json!(3), DEVICE, NOW)
            .expect("the first write establishes the type");
        Ok(())
    })
    .expect("the write");

    let refused = db
        .call_blocking(|conn: &mut Connection| {
            Ok(properties::set(
                conn,
                "note",
                "note-1",
                "count",
                json!("three"),
                DEVICE,
                NOW,
            ))
        })
        .expect("the call");

    match refused {
        Err(PropertyError::Retyped { name, .. }) => assert_eq!(name, "count"),
        other => panic!("expected a Retyped refusal, got {other:?}"),
    }

    // And the original value is untouched: a refused write changes nothing.
    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    let count = metadata
        .properties
        .iter()
        .find(|property| property.name == "count")
        .expect("count");
    assert_eq!(count.value_json, "3");
}

/// Clearing leaves the key present and `null` (§13.4).
///
/// **Not a removal.** An absent key means "this sender does not know", so a
/// removed key would tell every other device that nothing changed rather than
/// that the user cleared it.
#[test]
fn clearing_a_property_leaves_the_key_present_and_null() {
    use memry_core::domain::properties;

    let (db, _vault) = vault("property-clear");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        properties::set(conn, "note", "note-1", "status", json!("done"), DEVICE, NOW)
            .expect("the write");
        properties::clear(conn, "note", "note-1", "status", DEVICE, NOW).expect("the clear");
        Ok(())
    })
    .expect("the calls");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    let status = metadata
        .properties
        .iter()
        .find(|property| property.name == "status")
        .expect("the key must still be present after a clear");
    assert_eq!(status.value_json, "null");
}

/// A clear is exempt from the retype rule, because `null` claims no type.
#[test]
fn clearing_is_not_a_retype() {
    use memry_core::domain::properties;

    let (db, _vault) = vault("property-clear-retype");
    write_note(&db, "note-1", "A note", &[], None);

    let result = db
        .call_blocking(|conn: &mut Connection| {
            properties::set(conn, "note", "note-1", "count", json!(7), DEVICE, NOW)
                .expect("the write");
            Ok(properties::clear(
                conn, "note", "note-1", "count", DEVICE, NOW,
            ))
        })
        .expect("the call");
    assert!(result.is_ok(), "a clear must never be refused as a retype");
}
