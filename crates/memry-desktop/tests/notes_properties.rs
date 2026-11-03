//! A note's property values over a real session, tier, watcher and index (Step 13k-3, #3530):
//! the panel's read, and the writes through the app-edit seam that change only the lines of the
//! keys they touch, follow in the record, keep an outside edit the panel had not shown, and
//! refuse a file whose outside edit the note has not taken.

use index_support::until;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::properties::PropertyValueView;
use memry_desktop::vault::app_edit::Kept;
use memry_desktop::vault::consumer::ChangeSource;
use memry_desktop::vault::hash::content_hash;
use serde_json::{Map, Value, json};

use crate::index_support;
use crate::notes_link_rewrite::{changes, id_at, opened, row_hash};
use crate::vault_env::Env;

const NOTE: &str = "---\n# kept as written\ntags: [x]\ndue: 2026-10-07\nstage: Draft\nscore: 3\n\
---\nThe body.\n";

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

/// The panel's record: what the read gives, by name.
fn record(views: &[PropertyValueView]) -> Map<String, Value> {
    views
        .iter()
        .map(|view| (view.name.clone(), view.value.clone()))
        .collect()
}

/// The values the note's synced record carries.
fn synced(e: &Env, id: &str) -> Value {
    let listed = e.core().note_files().listed_by_id(id).unwrap().unwrap();
    Value::Object(listed.properties)
}

#[test]
fn a_set_rewrites_only_the_changed_line_and_the_record_follows() {
    let (mut e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");

    let shown = notes.properties(&open, &id).unwrap();
    let types: Vec<(&str, &str)> = shown
        .iter()
        .map(|view| (view.name.as_str(), view.type_name.as_str()))
        .collect();
    assert_eq!(
        types,
        [("due", "date"), ("stage", "text"), ("score", "number")]
    );
    let base = record(&shown);
    assert_eq!(
        Value::Object(base.clone()),
        json!({ "due": "2026-10-07", "stage": "Draft", "score": 3 })
    );
    e.drain();

    let mut next = base.clone();
    next.insert("stage".into(), json!("Done"));
    next.insert("owner".into(), json!("Kaan"));
    next.remove("score");
    let set = notes.set_properties(&open, &id, next, base).unwrap();

    let expected = "---\n# kept as written\ntags: [x]\ndue: 2026-10-07\nstage: Done\n\
owner: Kaan\n---\nThe body.\n";
    assert_eq!(e.read("Plan.md"), expected);
    assert_eq!(set.removed, ["score"]);
    let stored = json!({ "due": "2026-10-07", "stage": "Done", "owner": "Kaan" });
    assert_eq!(Value::Object(set.properties), stored);
    assert_eq!(synced(&e, &id), stored);
    assert_eq!(e.body(&id), "The body.");
    assert_eq!(row_hash(&e, &id), Some(content_hash(expected)));
    // Told as an edit for the user; the watcher reported nothing back.
    assert_eq!(
        changes(&mut e),
        [("Plan.md".to_owned(), ChangeSource::AppEdit)]
    );

    // The record it was shown, sent back: nothing to write.
    let shown = record(&notes.properties(&open, &id).unwrap());
    notes
        .set_properties(&open, &id, shown.clone(), shown)
        .unwrap();
    assert_eq!(e.read("Plan.md"), expected);
    assert!(changes(&mut e).is_empty());
}

#[test]
fn a_set_keeps_an_outside_edit_the_panel_had_not_shown() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let base = record(&notes.properties(&open, &id).unwrap());

    // Another editor changes the score and adds a key; the note takes it.
    let outside = NOTE.replace("score: 3", "score: 4\nsource: web");
    e.write("Plan.md", &outside);
    until("the note took the outside edit", || {
        row_hash(&e, &id) == Some(content_hash(&outside))
    });

    // The stale panel sends its whole record with one change.
    let mut next = base.clone();
    next.insert("stage".into(), json!("Done"));
    notes.set_properties(&open, &id, next, base).unwrap();
    assert_eq!(e.read("Plan.md"), outside.replace("Draft", "Done"));
}

#[test]
fn a_file_the_note_has_not_taken_is_refused_and_left_as_it_is() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // The row names other bytes: an outside edit the note has not taken yet.
    e.core()
        .note_files()
        .set_hash(&id, Some("not-the-file"))
        .unwrap();
    let merged = notes.merge_properties(&open, &id, object(json!({ "stage": "Done" })));
    assert!(matches!(
        merged,
        Err(NotesError::EditKept(Kept::FileChanged))
    ));
    assert_eq!(e.read("Plan.md"), NOTE);
    assert_eq!(synced(&e, &id)["stage"], json!(null));
}

#[test]
fn a_merge_and_a_rename_keep_every_other_line() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");

    let merged = notes
        .merge_properties(
            &open,
            &id,
            object(json!({ "stage": null, "score": 5, "gone": null })),
        )
        .unwrap();
    // As Electron answers: every `null` name the note no longer holds.
    assert_eq!(merged.removed, ["stage", "gone"]);
    assert_eq!(
        e.read("Plan.md"),
        NOTE.replace("stage: Draft\n", "").replace("score: 3", "score: 5")
    );

    notes
        .rename_property(&open, &id, "due".into(), "deadline".into())
        .unwrap();
    // The date stays a date, at the end of the block.
    assert_eq!(
        e.read("Plan.md"),
        "---\n# kept as written\ntags: [x]\nscore: 5\ndeadline: 2026-10-07\n---\nThe body.\n"
    );
    assert_eq!(
        synced(&e, &id),
        json!({ "score": 5, "deadline": "2026-10-07" })
    );
    let taken = notes.rename_property(&open, &id, "score".into(), "deadline".into());
    assert!(matches!(taken, Err(NotesError::PropertyExists(_))));
}
