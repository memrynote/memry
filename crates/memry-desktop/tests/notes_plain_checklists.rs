//! `plainChecklists` on a note made or a template applied (Step 32h1, #3549): the checkbox lines
//! the write adds carry the plain marker, so the editor keeps them as checklists instead of
//! turning them into tasks (`createNote` and `applyTemplateToNote` over
//! `markAddedChecklistLinesPlain`). Each expected text is what Electron's
//! `markAddedChecklistLinesPlain` returns for the same input.
//!
//! | Test                                                               | Rule                         |
//! | ------------------------------------------------------------------ | ---------------------------- |
//! | a created note's body, the given one or its template's, is marked  | `createNote`                 |
//! | an applied template marks only the lines the note did not hold     | `applyTemplateToNote`        |
//! | without the option nothing is marked                               | the default                  |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::apply_template::{ApplyTemplateInput, TemplateMode};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::templates::{TemplateCreateInput, Templates};
use vault_env::{Env, env, indexed};

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

fn template(e: &Env, store: &Arc<dyn SecureStore>, content: &str) -> String {
    let open = e.session.current().unwrap();
    Templates::open(&open, store.clone())
        .unwrap()
        .create(
            &TemplateCreateInput {
                name: "Checklist".into(),
                content: content.into(),
                ..TemplateCreateInput::default()
            },
            NOW,
        )
        .unwrap()
        .id
}

#[test]
fn a_created_notes_body_given_or_from_its_template_is_marked() {
    let (e, notes, store) = opened(&[]);
    let open = e.session.current().unwrap();
    let from_template = template(&e, &store, "- [ ] from the template\n");

    let given = notes
        .create(
            &open,
            NewNoteFile {
                title: "Given".into(),
                content: "# T\n- [ ] new\n- [x] done\n".into(),
                plain_checklists: true,
                ..NewNoteFile::default()
            },
        )
        .unwrap();
    let templated = notes
        .create(
            &open,
            NewNoteFile {
                title: "Templated".into(),
                template: Some(from_template),
                plain_checklists: true,
                ..NewNoteFile::default()
            },
        )
        .unwrap();
    let unmarked = notes
        .create(
            &open,
            NewNoteFile {
                title: "Unmarked".into(),
                content: "- [ ] stays\n".into(),
                ..NewNoteFile::default()
            },
        )
        .unwrap();

    assert_eq!(
        e.read(&given.path),
        "# T\n- [ ] new {check}\n- [x] done {check}\n"
    );
    assert_eq!(e.read(&templated.path), "- [ ] from the template {check}\n");
    assert_eq!(e.read(&unmarked.path), "- [ ] stays\n");
}

#[test]
fn an_applied_template_marks_only_the_lines_the_note_did_not_hold() {
    let (e, notes, store) = opened(&[
        ("Plan.md", "Old\n- [ ] kept\n"),
        ("Other.md", "Old\n- [ ] kept\n"),
    ]);
    let open = e.session.current().unwrap();
    let id = template(&e, &store, "Body\n- [ ] kept\n- [ ] added\n");
    let id_at = |path: &str| {
        e.rows()
            .into_iter()
            .find(|(_, p)| p == path)
            .unwrap_or_else(|| panic!("no row at {path}"))
            .0
    };

    for (path, plain) in [("Plan.md", true), ("Other.md", false)] {
        notes
            .apply_template(
                &open,
                ApplyTemplateInput {
                    note_id: id_at(path),
                    template_id: id.clone(),
                    mode: TemplateMode::Body,
                    plain_checklists: plain,
                },
            )
            .unwrap();
    }

    assert_eq!(e.read("Plan.md"), "Body\n- [ ] kept\n- [ ] added {check}\n");
    assert_eq!(e.read("Other.md"), "Body\n- [ ] kept\n- [ ] added\n");
}
