//! Protocol §13.7.7.2: a tag rename or merge points every other definition's
//! `schema.extends` and relation `target` naming the old tag at the new one.
//! Twin of `rewriteSchemaReference` in `packages/contracts/src/tag-schema.ts`,
//! pinned by the `tag-schema-refs` vectors. Delete does not call it: a dangling
//! reference re-resolves if the tag comes back.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{edit, failed};
use crate::domain::tag_admin::DEFINITION_TYPE;
use crate::storage::repositories::Change;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn same_tag(value: Option<&Value>, key: &str) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|name| name.trim().to_lowercase() == key)
}

/// The rewritten schema with `t + 1`, or `None` when nothing names `from` (or
/// `to` is `from`). Every other key, at every depth, is kept.
pub fn rewrite_schema_reference(
    schema: &Map<String, Value>,
    from: &str,
    to: Option<&str>,
) -> Option<Map<String, Value>> {
    let from_key = from.trim().to_lowercase();
    let to_key = to.map(|t| t.trim().to_lowercase());
    if to_key.as_deref() == Some(from_key.as_str()) {
        return None;
    }
    let to_value = to_key.map_or(Value::Null, Value::String);
    let mut changed = false;
    let mut next = schema.clone();
    if same_tag(schema.get("extends"), &from_key) {
        next.insert("extends".into(), to_value.clone());
        changed = true;
    }
    if let Some(Value::Array(fields)) = next.get_mut("fields") {
        for field in fields.iter_mut() {
            let Some(relation) = field
                .as_object_mut()
                .and_then(|f| f.get_mut("relation"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            if same_tag(relation.get("target"), &from_key) {
                relation.insert("target".into(), to_value.clone());
                changed = true;
            }
        }
    }
    if !changed {
        return None;
    }
    let t = match schema.get("t").and_then(Value::as_f64) {
        Some(t) if t.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&t) => t as u64,
        _ => 0,
    };
    next.insert("t".into(), json!(t + 1));
    Some(next)
}

/// Rewrites every live definition's schema that references `from`, each
/// through the definition writer so it ticks its clock and lands in the outbox.
pub fn rewrite_definitions(
    conn: &Connection,
    from: &str,
    to: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, json_extract(payload, '$.schema') FROM sync_items
              WHERE item_type = ?1 AND deleted_at IS NULL AND payload IS NOT NULL
                AND json_valid(payload) AND json_type(payload, '$.schema') = 'object'",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([DEFINITION_TYPE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    for (id, raw) in rows {
        let Ok(Value::Object(schema)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(next) = rewrite_schema_reference(&schema, from, to) {
            edit(
                conn,
                DEFINITION_TYPE,
                &id,
                vec![("schema", Change::Set(Value::Object(next)))],
                device_id,
                now_ms,
            )?
            .acknowledge();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::tag_admin;
    use crate::storage::repositories::{InboundRecord, sync_items};
    use crate::storage::{Db, open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn rewrites_extends_and_targets_and_bumps_t() {
        let schema = obj(json!({
            "t": 2, "extends": " Job ", "x": {"y": 1},
            "fields": [{"name": "A", "relation": {"target": "JOB", "many": true}}, 5, {"name": "B"}]
        }));
        let next = rewrite_schema_reference(&schema, "job", Some("Career")).expect("changed");
        assert_eq!(
            Value::Object(next),
            json!({
                "t": 3, "extends": "career", "x": {"y": 1},
                "fields": [{"name": "A", "relation": {"target": "career", "many": true}}, 5, {"name": "B"}]
            })
        );
        assert!(rewrite_schema_reference(&schema, "job", Some("JOB")).is_none());
        assert!(rewrite_schema_reference(&schema, "other", None).is_none());
        let deleted =
            rewrite_schema_reference(&obj(json!({"t": -1, "extends": "job"})), "job", None);
        assert_eq!(
            deleted.map(Value::Object),
            Some(json!({"t": 1, "extends": null}))
        );
    }

    fn seed(db: &Db, item_type: &str, id: &str, payload: &str) {
        db.call_blocking(|conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: item_type.into(),
                    item_id: id.into(),
                    payload_json: payload.into(),
                    server_cursor: Some(1),
                    signer_device_id: Some("desk".into()),
                    updated_at: NOW,
                    deleted_at: None,
                },
                NOW,
            )?;
            Ok(())
        })
        .expect("seed");
    }

    fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open");
        seed(
            &db,
            "tag_definition",
            "job",
            r#"{"name":"job","color":"rose","clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "tag_definition",
            "work",
            r#"{"name":"work","color":"sage","clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "tag_definition",
            "person",
            r#"{"name":"person","color":"sky","clock":{"desk":1},"schema":{"t":4,"extends":"job","fields":[{"name":"Co","relation":{"target":"Job"}}]}}"#,
        );
        (db, dir)
    }

    fn person_schema(db: &Db) -> Value {
        db.call_blocking(|c| {
            let row = sync_items::load(c, DEFINITION_TYPE, "person")?.expect("person");
            let payload: Value =
                serde_json::from_str(&row.payload.expect("payload")).expect("json");
            Ok(payload["schema"].clone())
        })
        .expect("schema")
    }

    fn pending_person(db: &Db) -> bool {
        db.call_blocking(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = 'tag_definition' AND item_id = 'person'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(failed)
        })
        .expect("outbox")
            > 0
    }

    #[test]
    fn rename_and_merge_rewrite_referencing_schemas() {
        let (db, _d) = vault("tag-refs-rename");
        db.call_blocking(|c| {
            crate::domain::tag_rename::rename(c, "job", "career", "phone", NOW + 1)
        })
        .expect("rename");
        let schema = person_schema(&db);
        assert_eq!(schema["extends"], json!("career"));
        assert_eq!(schema["fields"][0]["relation"]["target"], json!("career"));
        assert_eq!(schema["t"], json!(5));
        assert!(pending_person(&db));

        db.call_blocking(|c| tag_admin::merge(c, "career", "Work", "phone", NOW + 2))
            .expect("merge");
        let schema = person_schema(&db);
        assert_eq!(schema["extends"], json!("work"));
        assert_eq!(schema["t"], json!(6));
    }

    #[test]
    fn delete_leaves_referencing_schemas_dangling() {
        let (db, _d) = vault("tag-refs-delete");
        let before = person_schema(&db);
        db.call_blocking(|c| tag_admin::delete(c, "job", "phone", NOW + 1))
            .expect("delete");
        assert_eq!(person_schema(&db), before);
        assert!(!pending_person(&db));
    }
}
