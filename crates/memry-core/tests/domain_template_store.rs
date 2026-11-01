//! The desktop template store on real SQLite (Step 13l), after desktop `vault/templates.ts`.
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | a create keeps every field and lists by name after built-ins | `createTemplate`, `listTemplates`     |
//! | an update replaces the properties and the rest it names      | `updateTemplate`                      |
//! | a built-in is read from code and never changed               | `assertNotBuiltIn`                    |
//! | a deleted template is gone for every call                    | `NOT_FOUND` after `deleteTemplate`    |
//! | a stored row with a built-in's id is never read              | the built-in wins                     |

use memry_core::api::errors::StorageError;
use memry_core::domain::reads;
use memry_core::domain::template_admin::TemplateEdit;
use memry_core::domain::template_store::{self, TemplateFields};
use memry_core::domain::templates::{self, NewTemplate};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-template-store-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

fn stage() -> Value {
    json!({ "name": "Stage", "type": "select", "value": "Draft", "options": ["Draft", "Final"] })
}

fn fields(name: &str) -> TemplateFields {
    TemplateFields {
        name: name.to_owned(),
        description: Some("coverage".into()),
        icon: Some("T".into()),
        tags: vec!["e2e-template".into()],
        properties: vec![stage()],
        content: "# Heading\n\nBody".into(),
    }
}

fn payload(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "template", id)
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("JSON")
}

#[test]
fn a_create_keeps_every_field_and_lists_by_name_after_the_built_ins() {
    let db = open("create");
    run(&db, |conn| {
        let zed = template_store::create(conn, &fields("zed"), DEVICE, NOW)?;
        let alpha = template_store::create(conn, &fields("Alpha"), DEVICE, NOW + 1)?;

        let got = template_store::get(conn, &alpha)?.expect("the new template");
        assert_eq!(got.name, "Alpha");
        assert_eq!(got.description.as_deref(), Some("coverage"));
        assert_eq!(got.icon.as_deref(), Some("T"));
        assert_eq!(got.tags, vec!["e2e-template"]);
        assert_eq!(got.properties, vec![stage()]);
        assert_eq!(got.content, "# Heading\n\nBody");
        assert!(!got.is_built_in);
        assert_eq!(got.created_at.as_deref(), Some("2025-10-09T08:53:20.001Z"));
        // The payload carries both arrays, as Electron's rows do.
        assert_eq!(payload(conn, &zed)["tags"], json!(["e2e-template"]));
        assert_eq!(payload(conn, &zed)["properties"], json!([stage()]));

        let names: Vec<String> = reads::templates(conn)?
            .into_iter()
            .map(|t| t.name)
            .collect();
        let built_ins = names.len() - 2;
        assert_eq!(&names[built_ins..], ["Alpha", "zed"]);
        assert!(template_store::create(conn, &fields("  "), DEVICE, NOW).is_err());
        Ok(())
    });
}

#[test]
fn an_update_replaces_the_properties_and_whatever_else_it_names() {
    let db = open("update");
    run(&db, |conn| {
        let id = template_store::create(conn, &fields("Mine"), DEVICE, NOW)?;
        let edit = TemplateEdit {
            properties: Some(vec![
                json!({ "name": "Due", "type": "date", "value": null }),
            ]),
            content: Some("new body".into()),
            ..TemplateEdit::default()
        };
        template_store::update(conn, &id, &edit, DEVICE, NOW + 5)?;
        let got = template_store::get(conn, &id)?.expect("the template");
        assert_eq!(
            got.properties,
            vec![json!({ "name": "Due", "type": "date", "value": null })]
        );
        assert_eq!(got.content, "new body");
        assert_eq!(got.name, "Mine", "a field the edit does not name stays");
        assert_eq!(got.modified_at.as_deref(), Some("2025-10-09T08:53:20.005Z"));
        Ok(())
    });
}

#[test]
fn a_built_in_is_read_from_code_and_never_changed() {
    let db = open("built-in");
    run(&db, |conn| {
        let meeting = template_store::get(conn, "meeting-notes")?.expect("a built-in");
        assert!(meeting.is_built_in);
        assert_eq!(meeting.properties.len(), 3);
        assert_eq!(meeting.properties[2]["options"][1], json!("completed"));
        assert_eq!(meeting.created_at, None);

        let edit = TemplateEdit {
            name: Some("x".into()),
            ..TemplateEdit::default()
        };
        assert!(matches!(
            template_store::update(conn, "meeting-notes", &edit, DEVICE, NOW),
            Err(StorageError::Invalid { .. })
        ));
        assert!(matches!(
            template_store::delete(conn, "blank", DEVICE, NOW),
            Err(StorageError::Invalid { .. })
        ));
        Ok(())
    });
}

#[test]
fn a_deleted_template_is_gone_for_every_call() {
    let db = open("deleted");
    run(&db, |conn| {
        let id = template_store::create(conn, &fields("Gone"), DEVICE, NOW)?;
        template_store::delete(conn, &id, DEVICE, NOW + 1)?;
        assert_eq!(template_store::get(conn, &id)?, None);
        let not_found = |result: Result<(), StorageError>| {
            assert!(
                matches!(result, Err(StorageError::NotFound { .. })),
                "{result:?}"
            )
        };
        not_found(template_store::delete(conn, &id, DEVICE, NOW + 2));
        not_found(template_store::update(
            conn,
            &id,
            &TemplateEdit::default(),
            DEVICE,
            NOW + 2,
        ));
        not_found(template_store::delete(conn, "never-was", DEVICE, NOW + 2));
        Ok(())
    });
}

#[test]
fn a_stored_row_with_a_built_ins_id_is_never_read() {
    let db = open("impostor");
    run(&db, |conn| {
        templates::create(
            conn,
            &NewTemplate {
                id: "blank",
                name: "Impostor",
                description: None,
                icon: None,
                tags: &[],
                properties: &[],
                content: "not the built-in",
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        let got = template_store::get(conn, "blank")?.expect("the built-in");
        assert_eq!((got.name.as_str(), got.is_built_in), ("Blank Note", true));
        Ok(())
    });
}
