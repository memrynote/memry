//! A template applied to a note that exists (Step 13l-4, #3530), after Electron's
//! `applyTemplateToNote` and `buildTemplateApplyUpdate`, on a real vault under the running tier
//! and watcher: the file, the note's document, its row and its record.
//!
//! | Test                                                              | Rule                                    |
//! | ----------------------------------------------------------------- | --------------------------------------- |
//! | full: body, tags, the values the note lacks, the icon it lacks    | `buildTemplateApplyUpdate` `full`       |
//! | body: only the body, its `#tags` moving the header as a save does | `full` off; `nextHeaderTags`            |
//! | a note whose document is ahead of its file is kept as it is       | the app-edit seam; no record written    |
//! | a template or a note that is not there                            | `NOT_FOUND`                             |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::apply_template::{ApplyTemplateInput, TemplateMode};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::templates::{
    TemplateCreateInput, TemplateProperty, TemplatePropertyType, Templates,
};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::note_file::NoteFileError;
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
fn a_note_whose_document_is_ahead_of_its_file_is_kept_as_it_is() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let template = brief(&e, &store);
    e.edit_in_app(&store, &id, "Typed in the app");

    let kept = notes.apply_template(&open, input(&id, &template, TemplateMode::Full));

    assert!(
        matches!(
            kept,
            Err(NotesError::File(NoteFileError::ChangedUnderWrite))
        ),
        "{kept:?}"
    );
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
