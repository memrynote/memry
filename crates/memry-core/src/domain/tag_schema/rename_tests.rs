//! [`super::rename_in_definitions`] and the job record against a real `data.db`.

use serde_json::{Value, json};

use super::*;
use crate::domain::notes::failed;
use crate::storage::repositories::{InboundRecord, sync_items};
use crate::storage::{Db, open_data, test_support::temp_dir};

const NOW: i64 = 1_760_000_000_000;

/// `person` lists Phone and has a saved view on it; `company` lists Mobile; `newer` holds a
/// schema this build cannot read and a view on Phone.
fn seeded(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open");
    let view = json!([{
        "id": "v1", "later": 1,
        "columns": [{"id": "title"}, {"id": "Phone", "width": 120}],
        "order": [{"property": "Phone", "direction": "asc"}],
        "groupBy": {"property": "Phone"}
    }]);
    let items = [
        json!({"name": "person", "color": "sky", "clock": {"d": 1},
               "schema": {"t": 1, "fields": [{"name": "Role"}, {"name": "Phone"}]},
               "views": view}),
        json!({"name": "company", "color": "red", "clock": {"d": 1},
               "schema": {"t": 1, "fields": [{"name": "Mobile"}]}}),
        json!({"name": "newer", "color": "red", "clock": {"d": 1},
               "schema": {"t": "x"}, "views": [{"columns": [{"id": "Phone"}]}]}),
    ];
    db.call_blocking(move |conn| {
        for item in &items {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: "tag_definition".into(),
                    item_id: item["name"].as_str().unwrap().into(),
                    payload_json: item.to_string(),
                    server_cursor: Some(1),
                    signer_device_id: Some("desk".into()),
                    updated_at: NOW,
                    deleted_at: None,
                },
                NOW,
            )?;
        }
        Ok(())
    })
    .expect("seed");
    (db, dir)
}

fn payload(db: &Db, id: &str) -> Value {
    let id = id.to_owned();
    db.call_blocking(move |c| {
        let row = sync_items::load(c, "tag_definition", &id)?.expect("definition");
        Ok(serde_json::from_str(&row.payload.expect("payload")).expect("json"))
    })
    .expect("payload")
}

fn pending(db: &Db) -> i64 {
    db.call_blocking(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'tag_definition'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(failed)
    })
    .expect("outbox")
}

fn rename(db: &Db, from: &str, to: &str, resuming: bool) -> Result<Vec<String>, SaveError> {
    let (from, to) = (from.to_owned(), to.to_owned());
    db.call_blocking(move |c| Ok(rename_in_definitions(c, &from, &to, resuming, "me", NOW)))
        .expect("call")
}

#[test]
fn a_rename_writes_each_schema_and_view_in_one_definition_write_and_a_rerun_writes_nothing() {
    let (db, _dir) = seeded("field-rename-defs");
    assert_eq!(
        rename(&db, "Phone", "Cell", false).unwrap(),
        ["newer", "person"]
    );
    let person = payload(&db, "person");
    assert_eq!(
        person["schema"],
        json!({"t": 2, "fields": [{"name": "Role"}, {"name": "Cell"}]})
    );
    assert_eq!(
        person["views"],
        json!([{
            "id": "v1", "later": 1,
            "columns": [{"id": "title"}, {"id": "Cell", "width": 120}],
            "order": [{"property": "Cell", "direction": "asc"}],
            "groupBy": {"property": "Cell"}
        }])
    );
    // A schema a newer build wrote is left byte for byte; its view still follows the field.
    let newer = payload(&db, "newer");
    assert_eq!(newer["schema"], json!({"t": "x"}));
    assert_eq!(newer["views"], json!([{"columns": [{"id": "Cell"}]}]));
    assert_eq!(pending(&db), 2, "one outbox row per changed definition");

    // A crash after this step: the resumed run changes nothing more.
    assert!(rename(&db, "Phone", "Cell", true).unwrap().is_empty());
    assert_eq!(payload(&db, "person"), person);
}

#[test]
fn a_rename_a_schema_refuses_writes_nothing() {
    let (db, _dir) = seeded("field-rename-refused");
    // company has Mobile beside nothing: a schema listing both names refuses.
    db.call_blocking(|c| {
        super::super::save(
            c,
            "company",
            &SchemaEdit::AddField {
                field: super::super::NewField {
                    name: "Phone".into(),
                    relation: None,
                },
                index: None,
            },
            "me",
            NOW,
        )
        .map_err(|e| StorageError::Failed {
            what: format!("{e:?}"),
        })
    })
    .unwrap();
    let before = payload(&db, "person");
    let outbox = pending(&db);
    let refused = db
        .call_blocking(|c| Ok(plan(c, "Phone", "mobile")))
        .unwrap();
    assert!(
        matches!(&refused, Err(SaveError::Edit(SchemaEditError::DuplicateField { defined_by, .. })) if defined_by == "company"),
        "{refused:?}"
    );
    assert!(matches!(
        rename(&db, "Phone", "Tags", false),
        Err(SaveError::Edit(SchemaEditError::ReservedName { .. }))
    ));
    assert_eq!(payload(&db, "person"), before);
    assert_eq!(pending(&db), outbox);
    // Resumed, the field already holding the new name takes the old one's place.
    assert_eq!(rename(&db, "Phone", "mobile", true).unwrap().len(), 3);
    assert_eq!(
        payload(&db, "company")["schema"]["fields"],
        json!([{"name": "Mobile"}])
    );
}

#[test]
fn the_job_is_recorded_until_finished_and_one_that_does_not_read_says_so() {
    let (db, _dir) = seeded("field-rename-job");
    let job = FieldRenameJob {
        from: "Phone".into(),
        to: "Cell".into(),
        run_id: "r1".into(),
    };
    let read = || db.call_blocking(|c| recorded(c)).unwrap();
    assert_eq!(read(), None);
    let written = job.clone();
    db.call_blocking(move |c| record(c, &written)).unwrap();
    assert_eq!(read(), Some(RecordedRename::Job(job)));
    db.call_blocking(|c| write_meta(c, JOB, r#"{"from":"A","to":"B"}"#))
        .unwrap();
    assert!(matches!(read(), Some(RecordedRename::Job(j)) if j.run_id == "resume"));
    db.call_blocking(|c| write_meta(c, JOB, "[1]")).unwrap();
    assert!(matches!(read(), Some(RecordedRename::Unreadable(_))));
    db.call_blocking(|c| finish(c)).unwrap();
    assert_eq!(read(), None);
}

#[test]
fn a_reserved_name_is_refused_with_no_schema_to_refuse_it() {
    let dir = temp_dir("field-rename-reserved");
    let db = open_data(&dir.path().join("data.db")).expect("open");
    let refused = db
        .call_blocking(|c| Ok(plan(c, "Phone", " tags ")))
        .unwrap();
    assert!(
        matches!(&refused, Err(SaveError::Edit(SchemaEditError::ReservedName { name })) if name == "tags"),
        "{refused:?}"
    );
}
