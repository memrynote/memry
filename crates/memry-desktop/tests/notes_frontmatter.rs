//! Named frontmatter keys edited in the app (`notes:update` with `frontmatter`, #3530 13q-2)
//! over a real session, tier, watcher and index: the cover and its framing, and the full-width
//! toggle. They ride the editor save's write (`ChangeSource::Save`), as a header tag edit does.
//! Only the named keys' lines change, a `null` one goes, the record follows (the property keys
//! the edit touched, the 13k-3 rule, and the cover a push carries) with one queued push, and the
//! keys Memry writes through their own edits are refused, each naming its owner.

use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::vault::consumer::ChangeSource;
use memry_desktop::vault::hash::content_hash;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::notes_link_rewrite::{changes, id_at, opened, row_hash};
use crate::vault_env::Env;

const NOTE: &str = "---\n# kept as written\ntags: [x]\ncover: shelf.png\nstage: Draft\n---\n\
The body.\n";

fn update(id: &str, frontmatter: Value) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        frontmatter: Some(frontmatter.as_object().unwrap().clone()),
        ..NoteUpdateInput::default()
    }
}

/// The note's stored record payload, as a push would read it.
fn payload(e: &Env, id: &str) -> Map<String, Value> {
    let conn = Connection::open(e.vault.join(".memry/core/data.db")).unwrap();
    let raw: String = conn
        .query_row(
            "SELECT payload FROM sync_items WHERE item_type = 'note' AND item_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// The record pushes queued for `id` since the last [`clear_outbox`].
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
fn a_framing_edit_writes_only_its_keys_and_the_records_cover_follows() {
    let (mut e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let properties = |e: &Env| {
        e.core()
            .note_files()
            .listed_by_id(&id)
            .unwrap()
            .unwrap()
            .properties
    };
    let before = properties(&e);
    e.drain();
    clear_outbox(&e);

    notes
        .update(
            &open,
            update(&id, json!({ "coverFocus": 30, "coverZoom": 1.5 })),
        )
        .unwrap();
    let expected = "---\n# kept as written\ntags: [x]\ncover: shelf.png\nstage: Draft\n\
coverFocus: 30\ncoverZoom: 1.5\n---\nThe body.\n";
    assert_eq!(e.read("Plan.md"), expected);
    assert_eq!(row_hash(&e, &id), Some(content_hash(expected)));
    assert_eq!(
        changes(&mut e),
        [("Plan.md".to_owned(), ChangeSource::Save)]
    );
    let stored = payload(&e, &id);
    assert_eq!(
        stored["cover"],
        json!({ "ref": "shelf.png", "focus": 30, "focusX": 50, "zoom": 1.5, "height": 200 })
    );
    assert_eq!(upserts(&e, &id), 1, "one push for the edit");
    assert_eq!(properties(&e), before, "cover keys are no properties");

    // The same keys again: nothing to write.
    notes
        .update(&open, update(&id, json!({ "coverFocus": 30 })))
        .unwrap();
    assert_eq!(e.read("Plan.md"), expected);
    assert!(changes(&mut e).is_empty());
}

#[test]
fn a_removed_cover_drops_its_lines_and_nulls_the_records_cover() {
    let text = "---\ncover: wash:sage\ncoverCredit: Ann\nstage: Draft\n---\nThe body.\n";
    let (mut e, notes, _) = opened(&[("Plan.md", text)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes
        .update(&open, update(&id, json!({ "coverFocus": 20 })))
        .unwrap();
    assert_eq!(payload(&e, &id)["cover"]["focus"], json!(20));
    e.drain();

    let removal = json!({ "cover": null, "coverFocus": null, "coverCredit": null,
        "coverCreditUrl": null });
    notes.update(&open, update(&id, removal)).unwrap();
    assert_eq!(e.read("Plan.md"), "---\nstage: Draft\n---\nThe body.\n");
    let stored = payload(&e, &id);
    assert_eq!(
        (&stored["cover"], &stored["coverImage"]),
        (&Value::Null, &Value::Null)
    );
}

/// `fullWidth` is no key Memry reserves, so the record carries it as a property, the way
/// desktop's push reads every unreserved key.
#[test]
fn the_full_width_toggle_is_a_plain_key_the_record_carries() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let mut expected = e
        .core()
        .note_files()
        .listed_by_id(&id)
        .unwrap()
        .unwrap()
        .properties;
    expected.insert("fullWidth".to_owned(), json!(true));
    clear_outbox(&e);

    notes
        .update(&open, update(&id, json!({ "fullWidth": true })))
        .unwrap();
    assert!(
        e.read("Plan.md")
            .contains("stage: Draft\nfullWidth: true\n---\n")
    );
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(
        listed.properties, expected,
        "only the edited key reaches the record"
    );
    assert_eq!(upserts(&e, &id), 1, "one push for the toggle");
    assert!(
        payload(&e, &id).get("cover").is_none(),
        "an unchanged cover writes no field"
    );

    notes
        .update(&open, update(&id, json!({ "fullWidth": false })))
        .unwrap();
    assert!(e.read("Plan.md").contains("fullWidth: false\n"));
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(listed.properties["fullWidth"], json!(false));
}

#[test]
fn a_key_written_by_its_own_edit_is_refused_and_the_file_kept() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let owners = [
        ("tags", "headerTags"),
        ("aliases", "notes_edit_aliases"),
        ("properties", "properties_*"),
        ("writing", "the note's editor"),
    ];
    for (key, owner) in owners {
        let refused = notes.update(&open, update(&id, json!({ key: ["y"] })));
        assert!(
            matches!(&refused, Err(NotesError::ManagedKey { key: named, .. }) if *named == key),
            "{key}: {refused:?}"
        );
        let message = refused.unwrap_err().to_string();
        assert!(message.contains(owner), "{key} names its owner: {message}");
    }
    assert_eq!(e.read("Plan.md"), NOTE);
}
