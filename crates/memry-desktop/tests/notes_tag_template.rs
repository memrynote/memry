//! The template a header tag brings (Step 13l-4, #3530), after Electron's
//! `applyTagTemplateAfterAdd` and `undoTagTemplate` (`notes/tag-template.ts`), through
//! `notes:update` on a real vault under the running tier and watcher.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | an autofill tag fills an empty body, and the undo empties it      | `replaceBodyIf(body.trim() === '')`   |
//! | a body with text, or a tag that does not autofill, is offered     | `offered`                             |
//! | an undo after the body changed, or spent, is stale                | the hash of the filled body           |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::tag_template::{TagTemplateOutcome, UndoStatus, UndoTagTemplateInput};
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput, Updated};
use serde_json::{Value, json};
use vault_env::{Env, env, indexed};

const NOW: i64 = 1_760_000_000_000;
const MEETING_BODY: &str = "## Attendees\n\n-\n\n## Agenda\n\n1.\n2.\n3.\n\n## Notes\n\n\
## Action Items\n\n- [ ]\n";

fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
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
    let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
    (e, notes)
}

fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

/// A tag definition as another device synced it, with `schema`.
fn define_tag(e: &Env, name: &str, schema: Value) {
    let record = InboundRecord {
        item_type: "tag_definition".into(),
        item_id: name.into(),
        payload_json: json!({ "name": name, "color": "blue", "schema": schema }).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".into()),
        updated_at: NOW,
        deleted_at: None,
    };
    e.core()
        .db_handle()
        .call_blocking(move |conn| sync_items::apply_remote(conn, &record, NOW).map(drop))
        .expect("the definition");
}

fn add_tag(e: &Env, notes: &NotesService, id: &str, tag: &str) -> Updated {
    let open = e.session.current().unwrap();
    let input = NoteUpdateInput {
        id: id.into(),
        header_tags: Some(HeaderTagEditInput {
            add: Some(vec![tag.into()]),
            ..HeaderTagEditInput::default()
        }),
        ..NoteUpdateInput::default()
    };
    notes.update(&open, input).unwrap()
}

fn undo(e: &Env, notes: &NotesService, id: &str, token: &str) -> UndoStatus {
    let open = e.session.current().unwrap();
    let input = UndoTagTemplateInput {
        note_id: id.into(),
        undo_token: token.into(),
    };
    notes.undo_tag_template(&open, &input).unwrap()
}

fn schemas(e: &Env) {
    define_tag(
        e,
        "meeting",
        json!({ "t": 1, "template": { "id": "meeting-notes", "autofill": true } }),
    );
    define_tag(
        e,
        "brief",
        json!({ "t": 1, "template": { "id": "project-brief" } }),
    );
}

#[test]
fn an_autofill_tag_fills_an_empty_body_and_the_undo_empties_it() {
    let (e, notes) = opened(&[("Sync.md", "---\nkeep: 'as is'\n---\n")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");

    let updated = add_tag(&e, &notes, &id, "Meeting");

    let Some(TagTemplateOutcome::Applied { tag, undo_token }) = updated.tag_template else {
        panic!("{:?}", updated.tag_template);
    };
    assert_eq!(tag, "Meeting", "the tag as the user added it");
    let filled = format!("---\nkeep: 'as is'\ntags:\n  - Meeting\n---\n{MEETING_BODY}");
    assert_eq!(e.read("Sync.md"), filled);
    assert!(e.body(&id).starts_with("Attendees"), "{}", e.body(&id));

    assert_eq!(undo(&e, &notes, &id, &undo_token), UndoStatus::Restored);
    assert_eq!(
        e.read("Sync.md"),
        "---\nkeep: 'as is'\ntags:\n  - Meeting\n---\n"
    );
    assert_eq!(e.body(&id), "");
    // Spent.
    assert_eq!(undo(&e, &notes, &id, &undo_token), UndoStatus::Stale);
}

#[test]
fn a_body_with_text_or_a_tag_that_does_not_autofill_is_offered() {
    let (e, notes) = opened(&[("Kept.md", "My own text\n"), ("Plain.md", "")]);
    schemas(&e);
    let (kept, plain) = (id_at(&e, "Kept.md"), id_at(&e, "Plain.md"));

    let updated = add_tag(&e, &notes, &kept, "meeting");
    assert_eq!(
        updated.tag_template,
        Some(TagTemplateOutcome::Offered {
            tag: "meeting".into()
        })
    );
    assert_eq!(
        e.read("Kept.md"),
        "---\ntags:\n  - meeting\n---\nMy own text\n"
    );

    let updated = add_tag(&e, &notes, &plain, "brief");
    assert_eq!(
        updated.tag_template,
        Some(TagTemplateOutcome::Offered {
            tag: "brief".into()
        })
    );
    assert_eq!(e.read("Plain.md"), "---\ntags:\n  - brief\n---\n");

    // A tag with no template brings none.
    let updated = add_tag(&e, &notes, &plain, "loose");
    assert_eq!(updated.tag_template, None);
}

#[test]
fn an_undo_after_the_body_changed_is_stale_and_keeps_the_text() {
    let (e, notes) = opened(&[("Sync.md", "")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");
    let Some(TagTemplateOutcome::Applied { undo_token, .. }) =
        add_tag(&e, &notes, &id, "meeting").tag_template
    else {
        panic!("not applied");
    };
    let open = e.session.current().unwrap();
    let typed = NoteUpdateInput {
        id: id.clone(),
        content: Some(format!("{MEETING_BODY}Typed after\n")),
        ..NoteUpdateInput::default()
    };
    notes.update(&open, typed).unwrap();

    assert_eq!(undo(&e, &notes, &id, &undo_token), UndoStatus::Stale);
    assert!(e.read("Sync.md").ends_with("Typed after\n"));
    assert_eq!(undo(&e, &notes, &id, "made-up"), UndoStatus::Stale);
}
