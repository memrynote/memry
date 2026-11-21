//! Stage 36b2: tag categories, tag definitions, templates and custom icons, and the kept payload
//! keys of `sync_unknown_fields`. Each expected payload is the string Electron's
//! `buildPushPayload` (and `mergeUnknownPayloadFields`) returns for the seeded row.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::stage_vault_import;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::{Vault, electron_db, import};

const CREATED: &str = "2026-01-02T03:04:05.000Z";
const MODIFIED: &str = "2026-01-03T03:04:05.000Z";

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn seed_tags(conn: &Connection) {
    for (id, sort, clock, deleted) in [
        ("cat-1", 2, Value::Text(r#"{"dev":1}"#.into()), Value::Null),
        ("cat-2", 0, Value::Null, text("2026-01-05T00:00:00.000Z")),
    ] {
        electron_db::seed(
            conn,
            "tag_categories",
            &[
                ("id", text(id)),
                ("name", text("Work")),
                ("sort_order", Value::Integer(sort)),
                ("clock", clock),
                ("deleted_at", deleted),
                ("created_at", text(CREATED)),
                ("updated_at", text(MODIFIED)),
            ],
        );
    }
    for (name, authored, category, views, schema, clock) in [
        (
            "Work",
            1,
            text("cat-1"),
            text(r#"[{"name":"v","sort":1.0}]"#),
            text(r#"{"fields":{"a":{"v":1,"t":2}},"t":3}"#),
            text(r#"{"dev":2}"#),
        ),
        ("home", 0, Value::Null, text(""), text("[1]"), Value::Null),
        (
            "odd",
            2,
            Value::Null,
            text("not json"),
            text("{bad"),
            Value::Null,
        ),
        (
            "flat",
            0,
            Value::Null,
            text(r#"{"a":1}"#),
            Value::Null,
            Value::Null,
        ),
    ] {
        electron_db::seed(
            conn,
            "tag_definitions",
            &[
                ("name", text(name)),
                ("color", text("#ff0000")),
                ("color_authored", Value::Integer(authored)),
                ("category_id", category),
                ("views", views),
                ("schema", schema),
                ("clock", clock),
                ("created_at", text(CREATED)),
            ],
        );
    }
}

fn seed_template(conn: &Connection, id: &str, tags: &str, properties: &str, clock: Value) {
    electron_db::seed(
        conn,
        "templates",
        &[
            ("id", text(id)),
            ("name", text("Meeting")),
            ("icon", text("📝")),
            ("tags", text(tags)),
            ("properties", text(properties)),
            ("content", text("# Hi\n")),
            ("synced_at", text("2026-01-04T00:00:00.000Z")),
            ("clock", clock),
            ("created_at", text(CREATED)),
            ("modified_at", text(MODIFIED)),
        ],
    );
}

fn seed_unknown(conn: &Connection, item_type: &str, item_id: &str, fields: &str) {
    electron_db::seed(
        conn,
        "sync_unknown_fields",
        &[
            ("type", text(item_type)),
            ("item_id", text(item_id)),
            ("fields", text(fields)),
            ("updated_at", Value::Integer(1_767_000_000)),
        ],
    );
}

fn payload(core: &Connection, item_type: &str, item_id: &str) -> String {
    core.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        [item_type, item_id],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn records_carry_the_payload_electron_pushes_with_its_kept_keys() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    seed_tags(&conn);
    seed_template(
        &conn,
        "tpl-1",
        r#"["a","b"]"#,
        r#"[{"name":"n","type":"number","value":1.0,"opts":{"2":"x","1":"y"}}]"#,
        text(r#"{"dev":3}"#),
    );
    seed_template(&conn, "tpl-2", "[]", "[]", Value::Null);
    conn.execute(
        "UPDATE templates SET synced_at = NULL WHERE id = 'tpl-2'",
        [],
    )
    .unwrap();
    electron_db::seed(
        &conn,
        "custom_icons",
        &[
            ("id", text("icon-1")),
            ("name", text("Logo")),
            ("ext", text("png")),
            ("data", text("iVBORw0KGgo=")),
            ("created_at", text(CREATED)),
            ("updated_at", text(MODIFIED)),
        ],
    );
    electron_db::seed(
        &conn,
        "folder_configs",
        &[
            ("path", text("Projects")),
            ("icon", text("star")),
            ("clock", text(r#"{"dev-B":1}"#)),
            ("created_at", text(CREATED)),
            ("modified_at", text(MODIFIED)),
        ],
    );
    seed_unknown(&conn, "template", "tpl-2", r#"{"futureKey":{"x":1}}"#);
    seed_unknown(
        &conn,
        "folder_config",
        "Projects",
        r#"{"color":"red","icon":"old"}"#,
    );
    seed_unknown(&conn, "task", "gone", r#"{"x":1}"#);
    seed_unknown(&conn, "tag_definition", "home", "not json");
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 5, 6]);
    for (table, written, dropped) in [
        ("data.db/tag_categories", 2, 0),
        ("data.db/tag_definitions", 4, 0),
        ("data.db/templates", 2, 0),
        ("data.db/custom_icons", 1, 0),
        ("data.db/sync_unknown_fields", 2, 2),
    ] {
        let t = &report.tables[table];
        assert_eq!((t.target_count, t.dropped), (written, dropped), "{table}");
    }
    assert_eq!(report.dropped["unknownFieldsWithoutRecord"], 1);
    assert_eq!(report.dropped["unknownFieldsIgnored"], 1);

    let core = Connection::open(vault.core().join(DATA_FILE)).unwrap();
    for (item_type, id, expected) in [
        (
            "tag_category",
            "cat-1",
            format!(
                r#"{{"name":"Work","sortOrder":2,"deletedAt":null,"clock":{{"dev":1}},"createdAt":"{CREATED}","updatedAt":"{MODIFIED}"}}"#
            ),
        ),
        (
            "tag_category",
            "cat-2",
            format!(
                r#"{{"name":"Work","sortOrder":0,"deletedAt":"2026-01-05T00:00:00.000Z","createdAt":"{CREATED}","updatedAt":"{MODIFIED}"}}"#
            ),
        ),
        (
            "tag_definition",
            "Work",
            format!(
                r##"{{"name":"Work","color":"#ff0000","colorAuthored":true,"icon":null,"categoryId":"cat-1","sortOrder":0,"views":[{{"name":"v","sort":1}}],"schema":{{"fields":{{"a":{{"v":1,"t":2}}}},"t":3}},"clock":{{"dev":2}},"createdAt":"{CREATED}"}}"##
            ),
        ),
        (
            "tag_definition",
            "home",
            format!(
                r##"{{"name":"home","color":"#ff0000","colorAuthored":false,"icon":null,"categoryId":null,"sortOrder":0,"createdAt":"{CREATED}"}}"##
            ),
        ),
        (
            "tag_definition",
            "odd",
            format!(
                r##"{{"name":"odd","color":"#ff0000","colorAuthored":false,"icon":null,"categoryId":null,"sortOrder":0,"createdAt":"{CREATED}"}}"##
            ),
        ),
        (
            "template",
            "tpl-1",
            format!(
                r##"{{"id":"tpl-1","name":"Meeting","description":null,"icon":"📝","tags":["a","b"],"properties":[{{"name":"n","type":"number","value":1,"opts":{{"1":"y","2":"x"}}}}],"content":"# Hi\n","clock":{{"dev":3}},"syncedAt":"2026-01-04T00:00:00.000Z","createdAt":"{CREATED}","modifiedAt":"{MODIFIED}"}}"##
            ),
        ),
        (
            "template",
            "tpl-2",
            format!(
                r##"{{"futureKey":{{"x":1}},"id":"tpl-2","name":"Meeting","description":null,"icon":"📝","tags":[],"properties":[],"content":"# Hi\n","clock":null,"syncedAt":null,"createdAt":"{CREATED}","modifiedAt":"{MODIFIED}"}}"##
            ),
        ),
        (
            "custom_icon",
            "icon-1",
            format!(
                r#"{{"id":"icon-1","name":"Logo","ext":"png","data":"iVBORw0KGgo=","createdAt":"{CREATED}","updatedAt":"{MODIFIED}","clock":null,"syncedAt":null}}"#
            ),
        ),
        (
            "folder_config",
            "Projects",
            format!(
                r#"{{"color":"red","icon":"star","clock":{{"dev-B":1}},"createdAt":"{CREATED}","modifiedAt":"{MODIFIED}"}}"#
            ),
        ),
    ] {
        assert_eq!(payload(&core, item_type, id), expected, "{item_type}/{id}");
    }

    // The projections the app reads.
    let count = |sql: &str| -> i64 { core.query_row(sql, [], |row| row.get(0)).unwrap() };
    assert_eq!(
        count("SELECT count(*) FROM tag_categories WHERE deleted_at IS NOT NULL"),
        1
    );
    assert_eq!(
        count("SELECT count(*) FROM tag_definitions WHERE category_id = 'cat-1'"),
        1
    );
    assert_eq!(count("SELECT count(*) FROM templates"), 2);
    let synced_at: i64 = core
        .query_row(
            "SELECT synced_at FROM templates WHERE id = 'tpl-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(synced_at, 1_767_484_800_000);
}

#[test]
fn a_template_json_column_that_is_not_json_fails_the_import() {
    let vault = Vault::new();
    seed_template(&vault.data_conn(), "t", "[a", "[]", Value::Null);
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::MalformedRow {
            table: "templates",
            ..
        })
    ));
    assert!(!vault.staging().exists());
}

/// `JSON.parse` reads a lone surrogate escape that a Rust string cannot hold: the run stops
/// instead of storing a different payload.
#[test]
fn kept_keys_this_import_cannot_reproduce_fail_the_import() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    seed_template(&conn, "t", "[]", "[]", Value::Null);
    seed_unknown(&conn, "template", "t", r#"{"x":"\ud800"}"#);
    drop(conn);
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::MalformedRow {
            table: "sync_unknown_fields",
            ..
        })
    ));
    assert!(!vault.staging().exists());
}
