//! A template applied to a note that exists (Step 13l-4, #3530), after Electron's
//! `applyTemplateToNote` and `buildTemplateApplyUpdate`, on a real vault under the running tier
//! and watcher: the file, the note's document, its row and its record.
//!
//! | Test                                                              | Rule                                    |
//! | ----------------------------------------------------------------- | --------------------------------------- |
//! | full: body, tags, the values the note lacks, the icon it lacks    | `buildTemplateApplyUpdate` `full`       |
//! | a value only the record holds wins and is written to the file     | `{ ...template, ...note }`              |
//! | a value the file and the record hold apart: neither is replaced   | the record is never replaced whole      |
//! | a replaced body is kept as a version first, byte order mark and all | `writeNote`'s snapshot                |
//! | body: only the body, its `#tags` moving the header as a save does | `full` off; `nextHeaderTags`            |
//! | only the body's `#tags` changed: still `notes:tags-changed`       | `hasTagChange`                          |
//! | a note whose document is ahead of its file is kept as it is       | `note_edit_kept`; no record written     |
//! | a template or a note that is not there                            | `NOT_FOUND`                             |
//! | a locked note, or one in a locked folder                          | `assertNoteWritable`: `note_locked`     |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::domain::vault_locks::TargetKind;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::CoreError;
use memry_desktop::notes::apply_template::{ApplyTemplateInput, TemplateMode};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::templates::{
    TemplateCreateInput, TemplateProperty, TemplatePropertyType, Templates,
};
use memry_desktop::vault::app_edit::Kept;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use serde_json::{Map, Value, json};
use vault_env::{Env, QUIET, env, indexed};

const NOW: i64 = 1_760_000_000_000;

fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

fn property(name: &str, value: Value) -> TemplateProperty {
    TemplateProperty {
        name: name.into(),
        kind: TemplatePropertyType::Text,
        value,
        options: None,
    }
}

/// A brief: an icon, a tag, a value the note holds and one it does not, and a titled body.
fn brief(e: &Env, store: &Arc<dyn SecureStore>) -> String {
    let open = e.session.current().unwrap();
    Templates::open(&open, store.clone())
        .unwrap()
        .create(
            &TemplateCreateInput {
                name: "Brief".into(),
                icon: Some("🚀".into()),
                tags: vec!["brief".into()],
                properties: vec![
                    property("stage", json!("Draft")),
                    property("owner", json!("Kaan")),
                ],
                content: "# {{title}}\n\nFrom the template #brief".into(),
                ..TemplateCreateInput::default()
            },
            NOW,
        )
        .unwrap()
        .id
}

fn input(note_id: &str, template_id: &str, mode: TemplateMode) -> ApplyTemplateInput {
    ApplyTemplateInput {
        note_id: note_id.into(),
        template_id: template_id.into(),
        mode,
    }
}

/// The `Changed` facts of the next quiet spell, by source.
fn changes(e: &mut Env) -> Vec<(String, ChangeSource)> {
    std::thread::sleep(QUIET);
    e.drain()
        .into_iter()
        .filter_map(|fact| match fact {
            Applied::Changed { path, source, .. } => Some((path, source)),
            _ => None,
        })
        .collect()
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

const PLAN: &str = "---\nkeep: 'as is'\nstage: Done\ntags: [mine]\n---\nOld body\n";

#[test]
fn full_gives_the_body_tags_the_values_the_note_lacks_and_the_icon_it_lacks() {
    let (mut e, notes, store) = opened(&[("Plan.md", PLAN), ("Kept.md", "Kept body\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);
    e.drain();

    let applied = notes
        .apply_template(&open, input(&id, &template, TemplateMode::Full))
        .unwrap();

    let text = "---\nkeep: 'as is'\nstage: Done\ntags:\n  - mine\n  - brief\nowner: Kaan\n---\n\
# Plan\n\nFrom the template #brief\n";
    assert_eq!(e.read("Plan.md"), text);
    assert!(applied.tags_changed);
    assert_eq!(applied.note.header_tags, ["mine", "brief"]);
    assert_eq!(
        applied.note.properties,
        object(json!({ "keep": "as is", "stage": "Done", "owner": "Kaan" })),
        "the note's own value wins"
    );
    assert_eq!(applied.note.emoji.as_deref(), Some("🚀"));
    // The record follows the file, so the note syncs as it reads.
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(listed.tags, ["mine", "brief"]);
    assert_eq!(listed.properties.get("owner"), Some(&json!("Kaan")));
    assert_eq!(listed.emoji.as_deref(), Some("🚀"));
    // The document holds the template's body; the row names the file written.
    assert!(e.body(&id).contains("From the template"), "{}", e.body(&id));
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    assert_eq!(row.content_hash, Some(content_hash(text)));
    // Told as an edit for the user, so an open editor takes it; the watcher sends nothing back.
    assert_eq!(
        changes(&mut e),
        [("Plan.md".to_owned(), ChangeSource::AppEdit)]
    );

    // A note with an icon keeps it.
    let kept = id_at(&e, "Kept.md");
    e.core()
        .notes_writer(store.clone())
        .unwrap()
        .set_icon(kept.clone(), Some("📌".into()))
        .unwrap();
    let applied = notes
        .apply_template(&open, input(&kept, &template, TemplateMode::Full))
        .unwrap();
    assert_eq!(applied.note.emoji.as_deref(), Some("📌"));
}

#[test]
fn a_value_only_the_record_holds_wins_and_is_written_to_the_file() {
    let (e, notes, store) = opened(&[("Plan.md", "Old body\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);
    // Pulled from sync: in the record, not yet in the file (13k-4). `owner` is a number there,
    // which the template's text would retype.
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer
        .set_property(id.clone(), "stage".into(), "\"Review\"".into())
        .unwrap();
    writer
        .set_property(id.clone(), "owner".into(), "5".into())
        .unwrap();

    let applied = notes
        .apply_template(&open, input(&id, &template, TemplateMode::Full))
        .unwrap();

    assert_eq!(
        e.read("Plan.md"),
        "---\ntags:\n  - brief\nstage: Review\nowner: 5\n---\n# Plan\n\nFrom the template #brief\n"
    );
    assert_eq!(
        applied.note.properties,
        object(json!({ "stage": "Review", "owner": 5 }))
    );
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(listed.properties.get("stage"), Some(&json!("Review")));
    assert_eq!(listed.properties.get("owner"), Some(&json!(5)));
}

#[test]
fn a_value_the_file_and_the_record_hold_apart_is_left_on_both_sides() {
    // A pull set the record's `stage` and has not written the file yet (13k-4).
    let (e, notes, store) = opened(&[("Plan.md", "---\nstage: Draft\n---\nOld body\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);
    e.core()
        .notes_writer(store.clone())
        .unwrap()
        .set_property(id.clone(), "stage".into(), "\"Review\"".into())
        .unwrap();

    notes
        .apply_template(&open, input(&id, &template, TemplateMode::Full))
        .unwrap();

    assert!(
        e.read("Plan.md").starts_with("---\nstage: Draft\n"),
        "{}",
        e.read("Plan.md")
    );
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(listed.properties.get("stage"), Some(&json!("Review")));
    assert_eq!(listed.properties.get("owner"), Some(&json!("Kaan")));
}

#[test]
fn a_replaced_body_is_kept_as_a_version_first_byte_order_mark_and_all() {
    let with_mark = format!("\u{feff}{PLAN}");
    let (e, notes, store) = opened(&[("Plan.md", PLAN), ("Marked.md", &with_mark)]);
    let open = e.session.current().unwrap();
    let template = brief(&e, &store);

    for (path, raw) in [("Plan.md", PLAN), ("Marked.md", with_mark.as_str())] {
        let id = id_at(&e, path);
        notes
            .apply_template(&open, input(&id, &template, TemplateMode::Body))
            .unwrap();
        assert_eq!(e.versions(&id), [raw], "{path}");
    }
}

#[test]
fn body_replaces_only_the_body_and_its_tags_move_the_header_as_a_save_does() {
    let note = "---\nkeep: 'as is'\ntags: [old]\n---\nAbout #old\n";
    let (e, notes, store) = opened(&[("Plan.md", note)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);

    let applied = notes
        .apply_template(&open, input(&id, &template, TemplateMode::Body))
        .unwrap();

    // `#old` left the body and the header; `#brief` came with the body.
    let text = "---\nkeep: 'as is'\ntags:\n  - brief\n---\n# Plan\n\nFrom the template #brief\n";
    assert_eq!(e.read("Plan.md"), text);
    assert!(applied.tags_changed);
    assert_eq!(applied.note.properties, object(json!({ "keep": "as is" })));
    assert_eq!(applied.note.emoji, None, "no icon in body mode");
}

#[test]
fn a_body_whose_tags_alone_changed_still_tells_the_tags_changed() {
    // The header already holds `brief`; only the body gains `#brief`.
    let note = "---\ntags: [brief]\n---\nPlain\n";
    let (e, notes, store) = opened(&[("Plan.md", note)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);

    let applied = notes
        .apply_template(&open, input(&id, &template, TemplateMode::Body))
        .unwrap();

    assert_eq!(
        e.read("Plan.md"),
        "---\ntags: [brief]\n---\n# Plan\n\nFrom the template #brief\n"
    );
    assert!(applied.tags_changed);
}

#[test]
fn a_note_whose_document_is_ahead_of_its_file_is_kept_as_it_is() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);
    e.edit_in_app(&store, &id, "Typed in the app");

    let kept = notes.apply_template(&open, input(&id, &template, TemplateMode::Full));

    // Typing the write-back has not written yet: the user applies again once it is.
    let error = kept.unwrap_err();
    assert!(
        matches!(error, NotesError::EditKept(Kept::BodyAhead)),
        "{error:?}"
    );
    assert_eq!(error.kind_and_code().1, "note_edit_kept");
    assert_eq!(e.read("Plan.md"), PLAN);
    assert_eq!(e.body(&id), "Typed in the app");
    let listed = e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!(listed.emoji, None, "no record was written");
    assert!(!listed.tags.contains(&"brief".to_owned()));
}

#[test]
fn a_template_or_a_note_that_is_not_there_is_not_found() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);

    let gone = notes.apply_template(&open, input(&id, "gone", TemplateMode::Full));
    assert!(
        matches!(gone, Err(NotesError::TemplateNotFound(_))),
        "{gone:?}"
    );
    let missing = notes.apply_template(&open, input("missing", &template, TemplateMode::Full));
    assert!(
        matches!(missing, Err(NotesError::NotFound(_))),
        "{missing:?}"
    );
    assert_eq!(e.read("Plan.md"), PLAN);
    assert!(
        read::get(&open, &id, None)
            .unwrap()
            .unwrap()
            .emoji
            .is_none()
    );
}

#[test]
fn a_locked_note_or_one_in_a_locked_folder_is_refused_and_keeps_its_file() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN), ("Archive/Old.md", PLAN)]);
    let open = e.session.current().unwrap();
    let template = brief(&e, &store);
    let plan = id_at(&e, "Plan.md");
    let old = id_at(&e, "Archive/Old.md");
    let locks = e.core().locks();
    locks.set(TargetKind::Note, &plan, true).unwrap();
    locks.set(TargetKind::Folder, "Archive", true).unwrap();

    for (id, path) in [(&plan, "Plan.md"), (&old, "Archive/Old.md")] {
        let refused = notes.apply_template(&open, input(id, &template, TemplateMode::Full));
        let error = refused.unwrap_err();
        assert_eq!(error.kind_and_code().1, "note_locked", "{path}");
        assert_eq!(error.to_string(), "The owner made this note read-only.");
        assert_eq!(e.read(path), PLAN);
        assert!(
            e.versions(id).is_empty(),
            "{path}: no version of a refused apply"
        );
    }
}
