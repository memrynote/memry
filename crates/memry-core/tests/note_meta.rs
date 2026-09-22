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

// MARK: - Icon, cover and aliases (N701, N706)

/// The icon round-trips through the payload's `emoji` field.
#[test]
fn a_notes_icon_round_trips() {
    let (db, _vault) = vault("icon");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_icon(conn, "note-1", Some("🌱"), DEVICE, NOW)?;
        Ok(())
    })
    .expect("the write");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    assert_eq!(metadata.icon.as_deref(), Some("🌱"));
}

/// **Clearing an icon writes an explicit `null`, never an absent key.**
///
/// §13.4: an absent key means "this sender does not know", so dropping it
/// would tell every other device that nothing changed rather than that the
/// user cleared their icon.
#[test]
fn clearing_an_icon_writes_null_rather_than_removing_the_key() {
    let (db, _vault) = vault("icon-clear");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_icon(conn, "note-1", Some("🌱"), DEVICE, NOW)?;
        notes::set_icon(conn, "note-1", None, DEVICE, NOW)?;
        Ok(())
    })
    .expect("the writes");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    assert_eq!(metadata.icon, None, "the icon reads as cleared");

    // The key itself must still be in the payload, holding null.
    let payload: String = db
        .call_blocking(|conn: &mut Connection| {
            let raw: String = conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'note' AND item_id = 'note-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("the payload");
            Ok(raw)
        })
        .expect("read");
    let object: Value = serde_json::from_str(&payload).expect("JSON");
    assert_eq!(
        object.get("emoji"),
        Some(&Value::Null),
        "the key must be present and null, not removed: {payload}"
    );
}

/// **`coverImage` is not a field of the note schema**, and this is what it
/// means in practice: whatever another client wrote under that key survives
/// and reaches the shell as the JSON text the payload holds (FR-033).
///
/// It is the vectors' canonical *unknown key* case for exactly this reason,
/// so parsing it into a typed field here would make this client the only one
/// that believes the key is defined.
#[test]
fn an_unknown_cover_key_survives_and_reaches_the_shell_verbatim() {
    let (db, _vault) = vault("cover");
    write_note(&db, "note-1", "A note", &[], None);

    // Written the way another client would: a key this schema does not name.
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "UPDATE sync_items SET payload = json_set(payload, '$.coverImage', \
             json('{\"url\":\"memry://cover/1\",\"offsetY\":0.25}')) \
             WHERE item_type = 'note' AND item_id = 'note-1'",
            [],
        )
        .expect("the cover");
        Ok(())
    })
    .expect("the write");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    let cover = metadata.cover_json.expect("the cover must reach the shell");
    let parsed: Value = serde_json::from_str(&cover).expect("the cover is JSON");
    assert_eq!(parsed["url"], json!("memry://cover/1"));
    assert_eq!(parsed["offsetY"], json!(0.25));
}

/// A note with no cover key says so, rather than inventing an empty one.
#[test]
fn a_note_with_no_cover_reports_none() {
    let (db, _vault) = vault("cover-absent");
    write_note(&db, "note-1", "A note", &[], None);

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    assert_eq!(metadata.cover_json, None);
}

/// Aliases round-trip, and the empty case is written as an empty array rather
/// than as `null`: removing the last alias is a fact, and `null` would read as
/// "this sender does not know".
#[test]
fn a_notes_aliases_round_trip_including_the_empty_case() {
    let (db, _vault) = vault("aliases");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_aliases(
            conn,
            "note-1",
            &["Second name".to_owned(), "Third".to_owned()],
            DEVICE,
            NOW,
        )?;
        Ok(())
    })
    .expect("the write");

    let read = |db: &Db| {
        db.call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
            .expect("read")
            .expect("the note")
    };
    assert_eq!(read(&db).aliases, ["Second name", "Third"]);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_aliases(conn, "note-1", &[], DEVICE, NOW)?;
        Ok(())
    })
    .expect("the clear");
    assert!(read(&db).aliases.is_empty());
}

// MARK: - The tag screen's queries (N600)

/// Tags are counted across notes, ordered by use, and **folded for grouping
/// but not for display**.
///
/// `note_tags.tag` is `COLLATE NOCASE`, which is what FR-047's "letter-case
/// behaviour identical to desktop" means: `Café` and `CAFÉ` are one tag. The
/// name shown is a spelling the rows actually carry, never a lowercased
/// invention.
#[test]
fn every_tag_is_listed_with_its_note_count() {
    use memry_core::domain::reads;

    let (db, _vault) = vault("tag-list");
    write_note(&db, "note-1", "One", &["research".to_owned()], None);
    write_note(
        &db,
        "note-2",
        "Two",
        &["research".to_owned(), "urgent".to_owned()],
        None,
    );

    let tags = db
        .call_blocking(|conn: &mut Connection| reads::tags(conn))
        .expect("the tags");

    // Ordered by count, so the tag a user actually uses comes first.
    assert_eq!(tags[0].name, "research");
    assert_eq!(tags[0].note_count, 2);
    assert_eq!(tags[1].name, "urgent");
    assert_eq!(tags[1].note_count, 1);
}

/// Two ASCII-case spellings of one tag are one row, and the surviving
/// spelling is one a note really wrote.
#[test]
fn two_spellings_of_one_tag_count_as_one() {
    use memry_core::domain::reads;

    let (db, _vault) = vault("tag-case");
    write_note(&db, "note-1", "One", &["Research".to_owned()], None);
    write_note(&db, "note-2", "Two", &["RESEARCH".to_owned()], None);

    let tags = db
        .call_blocking(|conn: &mut Connection| reads::tags(conn))
        .expect("the tags");

    assert_eq!(tags.len(), 1, "one tag, two spellings: {tags:?}");
    assert_eq!(tags[0].note_count, 2);
    assert!(
        tags[0].name == "Research" || tags[0].name == "RESEARCH",
        "the name must be a spelling a note wrote, not a folded invention: {}",
        tags[0].name
    );
}

/// **Case folding is ASCII-only, on purpose, and `Café` / `CAFÉ` are two
/// tags.**
///
/// `COLLATE NOCASE` folds `A`-`Z` and nothing else, and `domain::tags::fold`
/// is `to_ascii_lowercase` to match it exactly. That is FR-047's "letter-case
/// behaviour identical to desktop": a core that folded Unicode here would
/// merge two tags desktop keeps apart, and the vaults would disagree about
/// how many tags exist.
///
/// Pinned as a test because it reads like a bug and is a decision.
#[test]
fn folding_is_ascii_only_so_two_accented_spellings_stay_two_tags() {
    use memry_core::domain::reads;

    let (db, _vault) = vault("tag-unicode");
    write_note(&db, "note-1", "One", &["Café".to_owned()], None);
    write_note(&db, "note-2", "Two", &["CAFÉ".to_owned()], None);

    let tags = db
        .call_blocking(|conn: &mut Connection| reads::tags(conn))
        .expect("the tags");
    assert_eq!(
        tags.len(),
        2,
        "non-ASCII case is not folded, matching desktop: {tags:?}"
    );
}

/// Opening a tag screen from one spelling finds the notes that used another
/// ASCII-case spelling of it.
#[test]
fn a_tag_screen_finds_notes_whatever_case_they_spelled_it_in() {
    use memry_core::domain::reads;

    let (db, _vault) = vault("tag-notes");
    write_note(&db, "note-1", "One", &["Research".to_owned()], None);
    write_note(&db, "note-2", "Two", &["RESEARCH".to_owned()], None);
    write_note(&db, "note-3", "Three", &["other".to_owned()], None);

    let found = db
        .call_blocking(|conn: &mut Connection| reads::notes_tagged(conn, "research"))
        .expect("the notes");

    let ids: Vec<&str> = found.iter().map(|note| note.id.as_str()).collect();
    assert_eq!(ids.len(), 2, "both spellings must be found: {ids:?}");
    assert!(ids.contains(&"note-1") && ids.contains(&"note-2"));
}

/// A tag nothing carries is an empty list, not an error.
#[test]
fn a_tag_no_note_carries_is_empty_rather_than_an_error() {
    use memry_core::domain::reads;

    let (db, _vault) = vault("tag-empty");
    write_note(&db, "note-1", "One", &["research".to_owned()], None);

    let found = db
        .call_blocking(|conn: &mut Connection| reads::notes_tagged(conn, "nothing"))
        .expect("the notes");
    assert!(found.is_empty());
}

/// A deleted note stops counting, because a tombstone is not a note.
#[test]
fn a_deleted_note_stops_counting_towards_its_tags() {
    use memry_core::domain::{notes, reads};

    let (db, _vault) = vault("tag-deleted");
    write_note(&db, "note-1", "One", &["research".to_owned()], None);
    write_note(&db, "note-2", "Two", &["research".to_owned()], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::delete(conn, "note-1", DEVICE, NOW)?;
        Ok(())
    })
    .expect("the delete");

    let tags = db
        .call_blocking(|conn: &mut Connection| reads::tags(conn))
        .expect("the tags");
    assert_eq!(tags[0].note_count, 1);

    let found = db
        .call_blocking(|conn: &mut Connection| reads::notes_tagged(conn, "research"))
        .expect("the notes");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "note-2");
}

// MARK: - The cover (N703)

/// A cover written here reads back through the same unknown-key path N208
/// reads, in the shape `payload-schemas.json` already carries for it.
#[test]
fn a_cover_round_trips_through_the_unknown_key() {
    let (db, _vault) = vault("cover-write");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_cover(conn, "note-1", Some("images/cover.png"), 0.25, DEVICE, NOW)?;
        Ok(())
    })
    .expect("the write");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    let cover: Value = serde_json::from_str(&metadata.cover_json.expect("a cover")).expect("JSON");
    assert_eq!(cover["url"], json!("images/cover.png"));
    assert_eq!(cover["offsetY"], json!(0.25));
}

/// **An offset outside the frame is clamped rather than stored.**
///
/// The offset decides which part of a tall image is visible; a value past the
/// ends would show an empty frame, and storing it would spread that to every
/// device.
#[test]
fn a_cover_offset_is_clamped_to_the_frame() {
    let (db, _vault) = vault("cover-clamp");
    write_note(&db, "note-1", "A note", &[], None);

    for (given, expected) in [(9.0, 1.0), (-4.0, 0.0)] {
        db.call_blocking(move |conn: &mut Connection| {
            notes::set_cover(conn, "note-1", Some("c.png"), given, DEVICE, NOW)?;
            Ok(())
        })
        .expect("the write");

        let metadata = db
            .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
            .expect("read")
            .expect("the note");
        let cover: Value =
            serde_json::from_str(&metadata.cover_json.expect("a cover")).expect("JSON");
        assert_eq!(cover["offsetY"], json!(expected), "{given} was not clamped");
    }
}

/// Removing a cover writes an explicit null rather than dropping the key: an
/// absent key means "this sender does not know" (§13.4), which is not what
/// removing a cover means.
#[test]
fn removing_a_cover_writes_null_rather_than_removing_the_key() {
    let (db, _vault) = vault("cover-remove");
    write_note(&db, "note-1", "A note", &[], None);

    db.call_blocking(|conn: &mut Connection| {
        notes::set_cover(conn, "note-1", Some("c.png"), 0.5, DEVICE, NOW)?;
        notes::set_cover(conn, "note-1", None, 0.5, DEVICE, NOW)?;
        Ok(())
    })
    .expect("the writes");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    assert_eq!(metadata.cover_json, None, "the cover reads as cleared");

    let payload: String = db
        .call_blocking(|conn: &mut Connection| {
            let raw: String = conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'note' AND item_id = 'note-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("the payload");
            Ok(raw)
        })
        .expect("read");
    let object: Value = serde_json::from_str(&payload).expect("JSON");
    assert_eq!(
        object.get("coverImage"),
        Some(&Value::Null),
        "the key must be present and null, not removed: {payload}"
    );
}

/// **Writing a cover must not disturb the note's own fields.**
///
/// It is an unknown key living beside them, and a write that re-serialised the
/// payload from a projection would drop whatever it did not know — which is
/// the loss §13.2 exists to prevent.
#[test]
fn writing_a_cover_leaves_the_notes_own_fields_alone() {
    let (db, _vault) = vault("cover-beside");
    write_note(
        &db,
        "note-1",
        "A note",
        &["research".to_owned()],
        Some(Map::from_iter([("count".to_owned(), json!(3))])),
    );

    db.call_blocking(|conn: &mut Connection| {
        notes::set_cover(conn, "note-1", Some("c.png"), 0.5, DEVICE, NOW)?;
        Ok(())
    })
    .expect("the write");

    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, "note-1"))
        .expect("read")
        .expect("the note");
    assert_eq!(metadata.tags, ["research"]);
    assert_eq!(
        metadata
            .properties
            .iter()
            .find(|property| property.name == "count")
            .map(|property| property.value_json.as_str()),
        Some("3")
    );
}
