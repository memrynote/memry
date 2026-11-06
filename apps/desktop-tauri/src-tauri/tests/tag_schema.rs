use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use memry_desktop::tags::schema::view::{TagSchemaCommandResultView, TagSchemaSnapshotView};
use memry_desktop::tags::schema::{Effects, Ran};
use memry_tauri::commands::tag_schema::announce;
use memry_tauri::events::{
    NoteTagsChangedEvent, PropertyDefinitionChangedEvent, TemplateCreatedEvent,
};
use tauri::Listener;
use tauri::test::mock_app;
use tauri_specta::Event;

fn ran(tags_changed: bool, definitions: &[&str], templates: &[&str]) -> Ran {
    Ran {
        result: TagSchemaCommandResultView {
            snapshot: TagSchemaSnapshotView {
                tags: BTreeMap::new(),
                objects: BTreeMap::new(),
                presets: Vec::new(),
                preset_strip_dismissed: false,
            },
            tag: None,
            rename: None,
        },
        tags_changed,
        effects: Effects {
            definitions: definitions.iter().map(|s| (*s).to_owned()).collect(),
            templates: templates.iter().map(|s| (*s).to_owned()).collect(),
        },
    }
}

#[test]
fn a_schema_edit_sends_its_definitions_templates_then_the_tag_list_refetch() {
    let app = mock_app();
    let heard = Arc::new(Mutex::new(Vec::<(&str, String)>::new()));
    for name in [
        PropertyDefinitionChangedEvent::NAME,
        TemplateCreatedEvent::NAME,
        NoteTagsChangedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            sink.lock()
                .expect("lock")
                .push((name, event.payload().to_owned()));
        });
    }
    let sent = |ran: Ran| {
        announce(app.handle(), &ran);
        std::mem::take(&mut *heard.lock().expect("lock"))
    };
    assert_eq!(
        sent(ran(true, &["Role"], &["tpl1"])),
        [
            (
                PropertyDefinitionChangedEvent::NAME,
                r#"{"name":"Role"}"#.to_owned()
            ),
            (TemplateCreatedEvent::NAME, r#"{"id":"tpl1"}"#.to_owned()),
            (NoteTagsChangedEvent::NAME, "null".to_owned()),
        ]
    );
    assert!(
        sent(ran(false, &[], &[])).is_empty(),
        "a no-op sends nothing"
    );
}
