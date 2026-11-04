//! A note made from a template (Step 13l, #3530), after `createNote` in
//! `vault/notes-crud.ts` and `applyTemplate` in `vault/templates.ts`, on a real vault under the
//! running tier.
//!
//! | Test                                                            | Rule                                  |
//! | --------------------------------------------------------------- | ------------------------------------- |
//! | a template gives the note its body, tags, properties and icon   | `applyTemplate`, merged as `createNote` |
//! | what the caller gives wins over the template's                   | body, values, tags, icon              |
//! | the title fills the template's placeholder, as written           | `{{title}}`                           |
//! | a tag's template applies when none is named                      | `resolveTagSchemas` `template`        |
//! | the folder's template applies after the tags', inherited         | `getFolderTemplate` (Step 13h)        |
//! | a template that is not there makes a plain note                  | `if (template)`, no fallback after    |
//! | the command tells an absent icon from a cleared one              | `emoji` undefined vs `null`           |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::view::NoteCreateInput;
use memry_desktop::templates::{TemplateCreateInput, Templates};
use memry_desktop::vault::folder_file;
use serde_json::{Map, Value, json};
use vault_env::{Env, env, indexed};

const NOW: i64 = 1_760_000_000_000;

/// Electron's `createNote({ title: 'Weekly Sync', template: 'meeting-notes', folder: 'work',
/// tags: ['work'], properties: { owner: 'Kaan' } })`, as its `writeMarkdownNote` writes it.
const WEEKLY_SYNC: &str = "---\ntags:\n  - meeting\n  - work\ndate: null\nattendees: ''\n\
status: scheduled\nowner: Kaan\n---\n## Attendees\n\n-\n\n## Agenda\n\n1.\n2.\n3.\n\n## Notes\n\n\
## Action Items\n\n- [ ]\n";

fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

fn note(title: &str, template: Option<&str>) -> NewNoteFile {
    NewNoteFile {
        title: title.into(),
        template: template.map(str::to_owned),
        ..NewNoteFile::default()
    }
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

#[test]
fn a_template_gives_the_note_its_body_tags_properties_and_icon() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let made = notes
        .create(
            &open,
            NewNoteFile {
                folder: Some("work".into()),
                tags: vec!["work".into()],
                properties: object(json!({ "owner": "Kaan" })),
                ..note("Weekly Sync", Some("meeting-notes"))
            },
        )
        .unwrap();
    assert_eq!(e.read("work/Weekly Sync.md"), WEEKLY_SYNC);
    assert_eq!(made.tags, ["meeting", "work"], "the template's tags first");
    assert_eq!(
        made.properties,
        object(json!({ "date": null, "attendees": "", "status": "scheduled", "owner": "Kaan" }))
    );
    assert_eq!(made.emoji.as_deref(), Some("📝"));
    assert!(made.content.starts_with("## Attendees"), "{}", made.content);

    let read = read::get(&open, &made.id, None).unwrap().expect("the note");
    assert_eq!(read.header_tags, ["meeting", "work"]);
    assert_eq!(read.properties, made.properties);
    assert_eq!(
        read.emoji.as_deref(),
        Some("📝"),
        "the record keeps the icon"
    );
    assert!(
        e.body(&made.id).starts_with("Attendees"),
        "the body was seeded"
    );
}

#[test]
fn what_the_caller_gives_wins_over_the_templates() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let mine = notes
        .create(
            &open,
            NewNoteFile {
                content: "My own agenda".into(),
                tags: vec!["meeting".into(), "Meeting".into()],
                properties: object(json!({ "status": "Active", "Priority": "High" })),
                emoji: Some(Some("🚀".into())),
                ..note("Mine", Some("meeting-notes"))
            },
        )
        .unwrap();
    assert_eq!(mine.content, "My own agenda");
    // `new Set`: an exact repeat goes, a case variant stays.
    assert_eq!(mine.tags, ["meeting", "Meeting"]);
    assert_eq!(
        mine.properties,
        object(json!({ "date": null, "attendees": "", "status": "Active", "Priority": "High" }))
    );
    assert_eq!(mine.emoji.as_deref(), Some("🚀"));

    // `emoji: null` asks for no icon, the template's included.
    let bare = notes
        .create(
            &open,
            NewNoteFile {
                emoji: Some(None),
                ..note("Bare", Some("meeting-notes"))
            },
        )
        .unwrap();
    assert_eq!(bare.emoji, None);
    let read = read::get(&open, &bare.id, None).unwrap().expect("the note");
    assert_eq!(read.emoji, None);
}

#[test]
fn the_title_fills_the_templates_placeholder_as_written() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let templates = Templates::open(&open, store).unwrap();
    let custom = templates
        .create(
            &TemplateCreateInput {
                name: "Titled".into(),
                content: "# {{title}}\n\nAbout {{title}}, {{ title }}.".into(),
                ..TemplateCreateInput::default()
            },
            NOW,
        )
        .unwrap();
    let made = notes
        .create(&open, note("Cost $& more", Some(&custom.id)))
        .unwrap();
    // Every `{{title}}` is the title as typed; `$&` is not a replacement pattern here.
    assert_eq!(
        made.content,
        "# Cost $& more\n\nAbout Cost $& more, {{ title }}."
    );
    assert_eq!(made.emoji, None, "a template without an icon gives none");
}

#[test]
fn a_tags_template_applies_when_none_is_named() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    define_tag(
        &e,
        "client",
        json!({ "t": 1, "template": { "id": "meeting-notes", "autofill": true } }),
    );
    define_tag(&e, "acme", json!({ "t": 1, "extends": "client" }));
    define_tag(&e, "plain", json!({ "t": 1 }));

    // The first tag with a template, by `foldTag`.
    let by_tag = notes
        .create(
            &open,
            NewNoteFile {
                tags: vec!["plain".into(), "Client".into()],
                ..note("By tag", None)
            },
        )
        .unwrap();
    assert_eq!(by_tag.tags, ["meeting", "plain", "Client"]);
    assert!(by_tag.content.starts_with("## Attendees"));
    assert_eq!(by_tag.emoji.as_deref(), Some("📝"));

    // A tag inherits its parent's template.
    let inherited = notes
        .create(
            &open,
            NewNoteFile {
                tags: vec!["acme".into()],
                ..note("Inherited", None)
            },
        )
        .unwrap();
    assert_eq!(inherited.tags, ["meeting", "acme"]);

    // A named template wins over the tag's.
    let named = notes
        .create(
            &open,
            NewNoteFile {
                tags: vec!["client".into()],
                ..note("Named", Some("blank"))
            },
        )
        .unwrap();
    assert_eq!(named.tags, ["client"]);
    assert_eq!(named.content, "");
    assert_eq!(named.emoji.as_deref(), Some("📄"));
}

#[test]
fn the_folders_template_applies_after_the_tags_inherited() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let set = |folder: &str, template: Option<&str>, inherit: bool| {
        folder_file::update(&e.vault, folder, |file| file.set(None, template, inherit)).unwrap();
    };
    set("meetings", Some("meeting-notes"), true);
    set("meetings/private", None, false);
    define_tag(
        &e,
        "standup",
        json!({ "t": 1, "template": { "id": "daily-standup", "autofill": true } }),
    );
    let made = |title: &str, folder: &str, tags: &[&str]| {
        let note = NewNoteFile {
            folder: Some(folder.into()),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            ..note(title, None)
        };
        notes.create(&open, note).unwrap()
    };

    // A folder below takes the template of the nearest folder above that names one.
    let inherited = made("Sync", "meetings/weekly", &[]);
    assert!(
        inherited.content.starts_with("## Attendees"),
        "{}",
        inherited.content
    );
    // `inherit: false` stops the walk.
    let stopped = made("Mine", "meetings/private/deeper", &[]);
    assert_eq!(stopped.content, "");
    // A tag's template comes before the folder's.
    let by_tag = made("Standup", "meetings", &["standup"]);
    assert!(
        by_tag.content.starts_with("## What I did yesterday"),
        "{}",
        by_tag.content
    );
    assert!(
        !by_tag.content.contains("## Attendees"),
        "{}",
        by_tag.content
    );
}

#[test]
fn a_template_that_is_not_there_makes_a_plain_note() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let unknown = notes.create(&open, note("Unknown", Some("gone"))).unwrap();
    assert_eq!((unknown.content.as_str(), unknown.emoji), ("", None));
    assert_eq!(e.read(&unknown.path), "");

    // A tag naming a deleted template: the note is plain; no later fallback is tried.
    let templates = Templates::open(&open, store).unwrap();
    let doomed = templates
        .create(
            &TemplateCreateInput {
                name: "Doomed".into(),
                content: "Doomed body".into(),
                ..TemplateCreateInput::default()
            },
            NOW,
        )
        .unwrap();
    templates.delete(&doomed.id, NOW + 1).unwrap();
    define_tag(
        &e,
        "stale",
        json!({ "t": 1, "template": { "id": doomed.id } }),
    );
    let stale = notes
        .create(
            &open,
            NewNoteFile {
                tags: vec!["stale".into()],
                ..note("Stale", None)
            },
        )
        .unwrap();
    assert_eq!(stale.tags, ["stale"]);
    assert_eq!(stale.content, "");
}

#[test]
fn the_command_tells_an_absent_icon_from_a_cleared_one() {
    let input = |value: Value| -> NoteCreateInput { serde_json::from_value(value).expect("input") };
    let absent = input(json!({ "title": "T", "template": "meeting-notes" }));
    assert_eq!(absent.template.as_deref(), Some("meeting-notes"));
    assert_eq!(absent.emoji, None);
    assert_eq!(
        input(json!({ "title": "T", "emoji": null })).emoji,
        Some(None)
    );
    assert_eq!(
        input(json!({ "title": "T", "emoji": "🚀" })).emoji,
        Some(Some("🚀".to_owned()))
    );
}
