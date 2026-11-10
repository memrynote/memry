//! The template a header tag brings (Step 13l-4, #3530), after Electron's
//! `applyTagTemplateAfterAdd` and `undoTagTemplate` (`notes/tag-template.ts`), through
//! `notes:update` on a real vault under the running tier and watcher.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | an autofill tag fills an empty body, and the undo empties it      | `replaceBodyIf(body.trim() === '')`   |
//! | a body of whitespace and a byte order mark is empty               | `String.prototype.trim`               |
//! | a body with text, or a tag that does not autofill, is offered     | `offered`                             |
//! | the first added tag with a template wins, in the caller's order   | `addedInOrder`                        |
//! | typing the file does not hold yet is never written over           | the app-edit seam, `Held`             |
//! | an undo after the body changed, or spent, or another token: stale | the hash of the filled body           |
//! | the reply says the body its save wrote, not the template after it | the editor's baseline (#3967)         |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::error::CoreError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::tag_template::{TagTemplateOutcome, UndoStatus, UndoTagTemplateInput};
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput, Updated};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use serde_json::{Value, json};
use vault_env::{Env, QUIET, env, indexed};

use crate::vault_exclude_read_only::exclude;

const NOW: i64 = 1_760_000_000_000;
const MEETING_BODY: &str = "## Attendees\n\n-\n\n## Agenda\n\n1.\n2.\n3.\n\n## Notes\n\n\
## Action Items\n\n- [ ]\n";

fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
    let (e, notes, _) = opened_with_store(files);
    (e, notes)
}

fn opened_with_store(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
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
    add_tags(e, notes, id, &[tag])
}

fn add_tags(e: &Env, notes: &NotesService, id: &str, tags: &[&str]) -> Updated {
    let open = e.session.current().unwrap();
    let input = NoteUpdateInput {
        id: id.into(),
        header_tags: Some(HeaderTagEditInput {
            add: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
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

fn applied_token(updated: Updated) -> String {
    match updated.tag_template {
        Some(TagTemplateOutcome::Applied { undo_token, .. }) => undo_token,
        other => panic!("not applied: {other:?}"),
    }
}

#[test]
fn an_autofill_tag_fills_an_empty_body_and_the_undo_empties_it() {
    let (mut e, notes) = opened(&[("Sync.md", "---\nkeep: 'as is'\n---\n")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");
    e.drain();

    let updated = add_tag(&e, &notes, &id, "Meeting");

    let Some(TagTemplateOutcome::Applied { tag, undo_token }) = updated.tag_template else {
        panic!("{:?}", updated.tag_template);
    };
    assert_eq!(tag, "Meeting", "the tag as the user added it");
    let filled = format!("---\nkeep: 'as is'\ntags:\n  - Meeting\n---\n{MEETING_BODY}");
    assert_eq!(e.read("Sync.md"), filled);
    assert!(e.body(&id).starts_with("Attendees"), "{}", e.body(&id));
    // The tag edit is the user's save; the fill is told as an outside edit, so an open editor
    // takes the template's body.
    assert_eq!(
        changes(&mut e),
        [
            ("Sync.md".to_owned(), ChangeSource::Save),
            ("Sync.md".to_owned(), ChangeSource::AppEdit)
        ]
    );

    assert_eq!(undo(&e, &notes, &id, &undo_token), UndoStatus::Restored);
    assert_eq!(
        e.read("Sync.md"),
        "---\nkeep: 'as is'\ntags:\n  - Meeting\n---\n"
    );
    assert_eq!(e.body(&id), "");
    // Spent.
    assert_eq!(undo(&e, &notes, &id, &undo_token), UndoStatus::Stale);
}

/// The note is read again after the save's turn ends, so the reply's note can hold what landed
/// after the save: here the template the tag brought. The editor compares later events with what
/// its save wrote, and that is `saved_content` (#3967).
#[test]
fn the_reply_says_the_body_its_save_wrote_not_the_template_after_it() {
    let (e, notes) = opened(&[("Sync.md", "---\nkeep: 'as is'\n---\nOld text\n")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");
    let open = e.session.current().unwrap();
    let input = NoteUpdateInput {
        id: id.clone(),
        content: Some(String::new()),
        header_tags: Some(HeaderTagEditInput {
            add: Some(vec!["Meeting".to_owned()]),
            ..HeaderTagEditInput::default()
        }),
        ..NoteUpdateInput::default()
    };

    let updated = notes.update(&open, input).unwrap();

    assert!(
        updated.note.content.starts_with("## Attendees"),
        "{}",
        updated.note.content
    );
    assert_eq!(updated.saved_content.as_deref(), Some(""));
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

#[test]
fn another_tokens_undo_is_stale_and_leaves_the_real_one() {
    let (e, notes) = opened(&[("Sync.md", "")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");
    let token = applied_token(add_tag(&e, &notes, &id, "meeting"));

    assert_eq!(undo(&e, &notes, &id, "made-up"), UndoStatus::Stale);
    assert!(e.read("Sync.md").ends_with(MEETING_BODY));
    assert_eq!(undo(&e, &notes, &id, &token), UndoStatus::Restored);
    assert_eq!(e.read("Sync.md"), "---\ntags:\n  - meeting\n---\n");
}

#[test]
fn a_body_of_whitespace_and_a_byte_order_mark_is_filled() {
    let (e, notes) = opened(&[("Sync.md", "  \n\u{feff}\n")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");

    applied_token(add_tag(&e, &notes, &id, "meeting"));

    assert!(
        e.read("Sync.md").ends_with(MEETING_BODY),
        "{}",
        e.read("Sync.md")
    );
}

#[test]
fn the_first_added_tag_with_a_template_wins_in_the_order_asked() {
    let (e, notes) = opened(&[("Sync.md", "")]);
    schemas(&e);
    let id = id_at(&e, "Sync.md");

    let updated = add_tags(&e, &notes, &id, &["brief", "meeting"]);

    assert_eq!(
        updated.tag_template,
        Some(TagTemplateOutcome::Offered {
            tag: "brief".into()
        })
    );
    assert_eq!(
        e.read("Sync.md"),
        "---\ntags:\n  - brief\n  - meeting\n---\n"
    );
}

#[test]
fn typing_the_file_does_not_hold_yet_is_never_written_over() {
    let (e, notes, store) = opened_with_store(&[("Sync.md", ""), ("Undo.md", "")]);
    schemas(&e);

    // The fill: typed, not written back yet, so the tag's template is only offered.
    let id = id_at(&e, "Sync.md");
    e.edit_in_app(&store, &id, "Typed in the app");
    let updated = add_tag(&e, &notes, &id, "meeting");
    assert_eq!(
        updated.tag_template,
        Some(TagTemplateOutcome::Offered {
            tag: "meeting".into()
        })
    );
    assert_eq!(e.read("Sync.md"), "---\ntags:\n  - meeting\n---\n");
    assert_eq!(e.body(&id), "Typed in the app");

    // The undo: typed over the filled body, not written back yet.
    let id = id_at(&e, "Undo.md");
    let token = applied_token(add_tag(&e, &notes, &id, "meeting"));
    e.edit_in_app(&store, &id, "Typed over the template");
    assert_eq!(undo(&e, &notes, &id, &token), UndoStatus::Stale);
    assert!(
        e.body(&id).starts_with("Typed over the template"),
        "{}",
        e.body(&id)
    );
    assert!(e.read("Undo.md").ends_with(MEETING_BODY));
}

/// A note excluded since its tag filled it: the undo is refused like every app write to it
/// (#3530 13m-7b-3b), not passed off as stale, and the body stays.
#[test]
fn the_undo_of_a_note_excluded_since_is_refused() {
    let (mut e, notes) = opened(&[("archive/Sync.md", "")]);
    schemas(&e);
    let id = id_at(&e, "archive/Sync.md");
    let token = applied_token(add_tag(&e, &notes, &id, "Meeting"));
    let filled = e.read("archive/Sync.md");
    exclude(&mut e, &["archive"]);

    let open = e.session.current().unwrap();
    let input = UndoTagTemplateInput {
        note_id: id.clone(),
        undo_token: token,
    };
    let refused = notes.undo_tag_template(&open, &input).unwrap_err();
    assert_eq!(refused.kind_and_code().1, "note_excluded");
    assert_eq!(e.read("archive/Sync.md"), filled);
}
