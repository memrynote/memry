//! Stage 36b4: agent conversations and messages, vault locks with their baselines and file
//! modes, sticky drafts, home pages and canvas folders. Each expected payload is the string
//! Electron's `buildPushPayload` returns for the seeded row, with the agent records' sealed
//! keys holding Electron's at-rest envelope as the core stores them.

use memry_core::crypto::agent_envelope::{AtRestKey, Purpose, seal};
use memry_core::crypto::agent_payload::open_payload;
use memry_core::domain::vault_locks;
use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::stage_vault_import;
use rusqlite::Connection;
use rusqlite::types::Value;
use zeroize::Zeroizing;

use super::{Vault, electron_db, import};

const KEY: [u8; 32] = [7; 32];
const TITLE: &str = "Secret plan";
const CONTENT: &str = r#"{"role":"assistant","text":"Secret answer"}"#;
const CREATED: &str = "2026-01-02T03:04:05.000Z";
const UPDATED: &str = "2026-01-03T03:04:05.000Z";

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

fn staged(core: &Connection, item_type: &str, id: &str) -> (String, Option<String>) {
    core.query_row(
        "SELECT payload, clock FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        [item_type, id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

fn seed_conversation(conn: &Connection, id: &str, title: Value) {
    electron_db::seed(
        conn,
        "agent_conversations",
        &[
            ("id", text(id)),
            ("vault_id", text("vault-1")),
            ("title_ciphertext", title),
            ("backend", text("claude_cli")),
            ("backend_model", Value::Null),
            ("trust_list", text(r#"["search"]"#)),
            ("pinned", Value::Integer(1)),
            ("vector_clock", text(r#"{"dev":3}"#)),
            (
                "field_clocks",
                text(r#"{"title":{"dev":2},"pinned":{"dev":3}}"#),
            ),
            ("created_at", Value::Integer(1_000)),
            ("updated_at", Value::Integer(2_000)),
            ("deleted_at", Value::Null),
            ("last_synced_at", Value::Integer(3_000)),
        ],
    );
}

fn seed_message(conn: &Connection, id: &str, status: &str, content: Value) {
    let attachments = seal(Purpose::Attachments, "[]", &KEY).unwrap();
    electron_db::seed(
        conn,
        "agent_messages",
        &[
            ("id", text(id)),
            ("conversation_id", text("c-1")),
            ("role", text("assistant")),
            ("content_ciphertext", content),
            ("attachments_ciphertext", text(&attachments)),
            ("tool_call_id", Value::Null),
            ("status", text(status)),
            ("vector_clock", text(r#"{"dev":1}"#)),
            ("created_at", Value::Integer(1_500)),
            ("updated_at", Value::Integer(1_600)),
            ("deleted_at", Value::Null),
        ],
    );
}

#[test]
fn agent_records_keep_electrons_envelopes_and_open_to_the_wire_payload() {
    let vault = Vault::new();
    let title = seal(Purpose::ConversationTitle, TITLE, &KEY).unwrap();
    let content = seal(Purpose::MessageContent, CONTENT, &KEY).unwrap();
    let conn = vault.data_conn();
    seed_conversation(&conn, "c-1", text(&title));
    seed_message(&conn, "m-1", "completed", text(&content));
    seed_message(&conn, "m-2", "streaming", text(&content));
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.tables["data.db/agent_conversations"].target_count, 1);
    assert_eq!(report.tables["data.db/agent_messages"].target_count, 2);
    assert_eq!(report.notices.get("unfinishedAgentMessages"), Some(&1));

    let core = installed(&vault);
    let (payload, clock) = staged(&core, "agent_conversation", "c-1");
    let title_json = serde_json::to_string(&title).unwrap();
    assert_eq!(
        payload,
        format!(
            r#"{{"vaultId":"vault-1","title":{title_json},"backend":"claude_cli","backendModel":null,"trustList":["search"],"pinned":true,"clock":{{"dev":3}},"fieldClocks":{{"title":{{"dev":2}},"pinned":{{"dev":3}}}},"createdAt":1000,"updatedAt":2000,"deletedAt":null}}"#
        )
    );
    assert_eq!(clock.as_deref(), Some(r#"{"dev":3}"#));
    let (field_clocks, column, synced_at): (String, String, i64) = core
        .query_row(
            "SELECT s.field_clocks, p.title, p.synced_at FROM sync_items s \
             JOIN agent_conversations p ON p.id = s.item_id \
             WHERE s.item_type = 'agent_conversation'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(field_clocks, r#"{"title":{"dev":2},"pinned":{"dev":3}}"#);
    assert_eq!(
        column, title,
        "the projection holds Electron's envelope byte for byte"
    );
    assert_eq!(synced_at, 3_000);
    let pending: i64 = core
        .query_row("SELECT count(*) FROM agent_sealed_pending", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0, "sealed, not sealed-pending");

    // The core's own open, under the vault key Step 37 installs, gives the wire payload.
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new(KEY)));
    let wire = open_payload("agent_conversation", &payload, false, &key)
        .unwrap()
        .unwrap();
    let wire: serde_json::Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(wire["title"], TITLE);
    let (message, _) = staged(&core, "agent_message", "m-1");
    let wire = open_payload("agent_message", &message, false, &key)
        .unwrap()
        .unwrap();
    let wire: serde_json::Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(wire["content"]["text"], "Secret answer");
    assert_eq!(wire["attachments"], serde_json::json!([]));
    assert_eq!(wire["status"], "completed");
    drop(core);

    // No plaintext reaches the core files.
    for suffix in ["", "-wal"] {
        let path = format!("{}{suffix}", vault.core().join(DATA_FILE).display());
        if let Ok(bytes) = std::fs::read(&path) {
            let haystack = String::from_utf8_lossy(&bytes);
            assert!(!haystack.contains("Secret"), "plaintext in data.db{suffix}");
        }
    }
}

#[test]
fn a_sealed_column_that_is_no_envelope_fails_naming_the_row() {
    let vault = Vault::new();
    seed_conversation(&vault.data_conn(), "c-1", text(TITLE));
    let Err(error) = stage_vault_import(vault.input()) else {
        panic!("the import was not refused");
    };
    assert!(
        matches!(
            error,
            ImportError::MalformedRow {
                table: "agent_conversations",
                what: "a sealed column is no agent envelope",
                ..
            }
        ),
        "{error:?}"
    );
}

pub(super) fn seed_lock(conn: &Connection, id: &str, kind: &str, target: &str, clock: Value) {
    electron_db::seed(
        conn,
        "vault_locks",
        &[
            ("id", text(id)),
            ("target_kind", text(kind)),
            ("target", text(target)),
            ("locked", Value::Integer(1)),
            ("created_at", text(CREATED)),
            ("updated_at", text(UPDATED)),
            ("clock", clock),
            ("synced_at", Value::Null),
        ],
    );
}

#[test]
fn a_locked_note_stays_locked_with_its_baseline_and_file_modes() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    seed_lock(&conn, "note:n-1", "note", "n-1", text(r#"{"dev":2}"#));
    seed_lock(&conn, "folder:Work", "folder", "Work", Value::Null);
    electron_db::seed(
        &conn,
        "vault_lock_baselines",
        &[
            ("note_id", text("n-1")),
            ("content_hash", text("abc123")),
            ("content", text("# Locked\n")),
            ("updated_at", text(UPDATED)),
        ],
    );
    electron_db::seed(
        &conn,
        "vault_lock_file_modes",
        &[
            ("path", text("Work/a.md")),
            ("mode", Value::Integer(0o100644)),
            ("identity", text("1234:1767000000000")),
        ],
    );
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = installed(&vault);
    let (payload, clock) = staged(&core, "vault_lock", "note:n-1");
    assert_eq!(
        payload,
        format!(
            r#"{{"targetKind":"note","target":"n-1","locked":true,"clock":{{"dev":2}},"createdAt":"{CREATED}","updatedAt":"{UPDATED}"}}"#
        )
    );
    assert_eq!(clock.as_deref(), Some(r#"{"dev":2}"#));
    // Unclocked as in Electron, with no outbox row: seeded after the first pull.
    let (payload, clock) = staged(&core, "vault_lock", "folder:Work");
    assert!(!payload.contains("clock"));
    assert_eq!(clock, None);
    let queued: i64 = core
        .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .unwrap();
    assert_eq!(queued, 0);

    assert!(vault_locks::is_note_locked(&core, "n-1", None).unwrap());
    assert!(vault_locks::is_note_locked(&core, "x", Some("Work/x.md")).unwrap());
    let baseline = vault_locks::baseline(&core, "n-1").unwrap().unwrap();
    assert_eq!(baseline.content, "# Locked\n");
    assert_eq!(baseline.content_hash, "abc123");
    assert_eq!(baseline.updated_at, 1_767_409_445_000);
    let mode = vault_locks::file_mode(&core, "Work/a.md").unwrap().unwrap();
    assert_eq!(mode.mode, 0o100644);
    // Electron's `ino:birthtimeMs` is not the lock guard's form: the first open binds its own.
    assert_eq!(mode.identity, None);
}

#[test]
fn drafts_home_pages_and_canvas_folders_import_as_electron_pushes_them() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    electron_db::seed(
        &conn,
        "sticky_drafts",
        &[
            ("id", text("d-1")),
            ("content", text("buy milk")),
            ("kind", text("task")),
            ("created_at", text(CREATED)),
            ("modified_at", text(UPDATED)),
            ("clock", text(r#"{"dev":1}"#)),
            ("synced_at", text(UPDATED)),
        ],
    );
    electron_db::seed(
        &conn,
        "home_pages",
        &[
            ("id", text("h-1")),
            ("name", text("Home")),
            ("icon", Value::Null),
            ("position", Value::Integer(2)),
            ("widgets", text(r#"[{"type":"tasks"}]"#)),
            ("cover", text(r##"{"kind":"color","value":"#fff"}"##)),
            ("created_at", text(CREATED)),
            ("updated_at", text(UPDATED)),
            ("clock", Value::Null),
            ("synced_at", Value::Null),
        ],
    );
    electron_db::seed(
        &conn,
        "canvas_folders",
        &[
            ("id", text("f-1")),
            ("vault_id", text("vault-1")),
            ("path", text("Boards")),
            ("icon", Value::Null),
            ("created_at", Value::Integer(10)),
            ("updated_at", Value::Integer(20)),
            ("deleted_at", Value::Integer(30)),
            ("clock", text(r#"{"dev":4}"#)),
            ("synced_at", Value::Integer(40)),
        ],
    );
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = installed(&vault);
    assert_eq!(
        staged(&core, "sticky_draft", "d-1").0,
        format!(
            r#"{{"id":"d-1","content":"buy milk","kind":"task","createdAt":"{CREATED}","modifiedAt":"{UPDATED}","clock":{{"dev":1}},"syncedAt":"{UPDATED}"}}"#
        )
    );
    let (payload, clock) = staged(&core, "home_page", "h-1");
    assert_eq!(
        payload,
        format!(
            r##"{{"id":"h-1","name":"Home","icon":null,"position":2,"widgets":"[{{\"type\":\"tasks\"}}]","cover":{{"kind":"color","value":"#fff"}},"createdAt":"{CREATED}","updatedAt":"{UPDATED}","clock":null,"syncedAt":null}}"##
        )
    );
    assert_eq!(clock, None);
    assert_eq!(
        staged(&core, "canvas_folder", "f-1").0,
        r#"{"id":"f-1","vaultId":"vault-1","path":"Boards","icon":null,"clock":{"dev":4},"deletedAt":30}"#
    );
    let deleted: Option<i64> = core
        .query_row(
            "SELECT deleted_at FROM canvas_folders WHERE id = 'f-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(deleted, Some(30), "a soft-deleted folder stays deleted");
}
