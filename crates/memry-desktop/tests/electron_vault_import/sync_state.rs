//! Stage 36c3: Electron's `sync_state` keys and `sync_history`, each into the core owner of
//! that state, read back from the installed core pair and, for the cursor, by a real core pull.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::TransportError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::import::DATA_FILE;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_desktop::electron_import::ImportError;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::queue::text;
use super::{NOW_MS, Vault, assert_refused, electron_db, import};

fn seed_key(vault: &Vault, key: &str, value: &str) {
    electron_db::seed(
        &vault.data_conn(),
        "sync_state",
        &[("key", text(key)), ("value", text(value))],
    );
}

fn core_conn(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

fn meta(vault: &Vault, key: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    core_conn(vault)
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .unwrap()
}

fn record_cursor(vault: &Vault) -> Option<String> {
    use rusqlite::OptionalExtension;
    core_conn(vault)
        .query_row(
            "SELECT cursor FROM sync_cursors WHERE scope = 'record'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .unwrap()
        .flatten()
}

/// A sync server that answers every request with an empty last page and records the URLs.
#[derive(Default)]
struct Server {
    urls: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Transport for Server {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.urls.lock().unwrap().push(request.url);
        let body = r#"{"items":[],"deleted":[],"hasMore":false,"nextCursor":4300}"#;
        Ok(HttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: body.as_bytes().to_vec(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Offline)
    }
}

struct NoRecords;

impl RecordCipher for NoRecords {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// The URL of the first request a desktop core pull of the installed vault sends.
fn first_pull_url(vault: &Vault) -> String {
    let server = Arc::new(Server::default());
    let db = memry_core::storage::open_data(&vault.core().join(DATA_FILE)).unwrap();
    let http = HttpClient::new(
        Arc::clone(&server) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").unwrap(),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        db,
        Declaration::desktop(),
        Arc::new(NoRecords),
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(pull.run(1))
        .unwrap();
    server.urls.lock().unwrap()[0].clone()
}

#[test]
fn a_resumed_pull_after_import_asks_from_electrons_cursor() {
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "4200");
    seed_key(&vault, "cursorSkipRepair", "done");
    let report = import(&vault);
    assert_eq!(report.tables["data.db/sync_state"].target_count, 2);
    assert_eq!(record_cursor(&vault).as_deref(), Some("4200"));
    // Electron's `isFreshDevice` is "no lastCursor": a device holding one runs no first sync.
    assert!(meta(&vault, "first_sync.completed").is_some());
    assert_eq!(
        first_pull_url(&vault),
        "https://sync.example/sync/changes?limit=500&cursor=4200&inline=1"
    );
}

#[test]
fn a_cursor_without_a_finished_repair_is_repaired_as_electron_would() {
    // Absent: Electron's next full sync resets the cursor and re-reads the feed (#2382).
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "4200");
    import(&vault);
    assert_eq!(meta(&vault, "sync.cursor_skip_repair"), None);
    assert_eq!(
        first_pull_url(&vault),
        "https://sync.example/sync/changes?limit=500"
    );

    // Pending: the re-read resumes from the stored cursor and never resets again.
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "50");
    seed_key(&vault, "cursorSkipRepair", "pending:900");
    import(&vault);
    assert_eq!(
        meta(&vault, "sync.cursor_skip_repair").as_deref(),
        Some("pending:900")
    );
    assert_eq!(
        first_pull_url(&vault),
        "https://sync.example/sync/changes?limit=500&cursor=50&inline=1"
    );

    // A value Electron reads as not started is not started for the core either.
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "50");
    seed_key(&vault, "cursorSkipRepair", "pending:soon");
    let report = import(&vault);
    assert_eq!(meta(&vault, "sync.cursor_skip_repair"), None);
    assert_eq!(report.dropped["unreadableCursorSkipRepair"], 1);
}

#[test]
fn a_cursor_electron_cannot_read_is_not_carried() {
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "42abc");
    let report = import(&vault);
    assert_eq!(record_cursor(&vault), None);
    assert_eq!(meta(&vault, "first_sync.completed"), None);
    assert_eq!(report.dropped["unreadableLastCursor"], 1);
}

#[test]
fn a_paused_vault_stays_paused() {
    for (value, stored) in [("true", "1"), ("false", "0")] {
        let vault = Vault::new();
        seed_key(&vault, "syncPaused", value);
        import(&vault);
        assert_eq!(
            meta(&vault, "sync.paused").as_deref(),
            Some(stored),
            "{value}"
        );
    }
}

#[test]
fn the_pack_watermark_is_carried() {
    let vault = Vault::new();
    seed_key(&vault, "packsAppliedThroughCursor", "777");
    import(&vault);
    assert_eq!(
        meta(&vault, "pack_bootstrap.applied_through_cursor").as_deref(),
        Some("777")
    );

    let vault = Vault::new();
    seed_key(&vault, "packsAppliedThroughCursor", "NaN");
    let report = import(&vault);
    assert_eq!(meta(&vault, "pack_bootstrap.applied_through_cursor"), None);
    assert_eq!(report.dropped["unreadablePacksAppliedThroughCursor"], 1);
}

#[test]
fn quarantined_items_survive_with_their_reasons() {
    let vault = Vault::new();
    let entry = |id: &str| {
        format!(
            r#"{{"itemId":"{id}","itemType":"note","signerDeviceId":"dev-B","failedAt":{},"attemptCount":3,"lastError":"bad signature {id}"}}"#,
            NOW_MS - 1_000
        )
    };
    seed_key(
        &vault,
        "quarantinedItems",
        &format!(
            r#"{{"v":2,"entries":[{},{},{{"itemId":7}}]}}"#,
            entry("n-1"),
            entry("n-2")
        ),
    );
    let report = import(&vault);
    let rows: Vec<(String, String, String, i64, i64, String)> = core_conn(&vault)
        .prepare(
            "SELECT item_type, item_id, signer_device_id, failed_at, attempt_count, last_error
             FROM sync_quarantine ORDER BY item_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0],
        (
            "note".into(),
            "n-1".into(),
            "dev-B".into(),
            NOW_MS - 1_000,
            3,
            "bad signature n-1".into()
        )
    );
    assert_eq!(report.notices["unreadableQuarantineEntries"], 1);

    // The id-keyed v1 array: Electron discards it on load.
    let vault = Vault::new();
    seed_key(&vault, "quarantinedItems", "[]");
    let report = import(&vault);
    assert_eq!(report.dropped["legacyQuarantineState"], 1);
}

#[test]
fn schema_invalid_items_are_refetched_and_keep_their_kind() {
    let vault = Vault::new();
    seed_key(
        &vault,
        "schemaInvalidItems",
        r#"{
          "task:t-1":{"id":"t-1","type":"task","kind":"payload","lastRefusedByVersion":"1.4.0","failedAt":1700000000000},
          "note:n-1":{"id":"n-1","type":"note","kind":"newer","lastRefusedByVersion":"1.4.0","failedAt":1700000000001},
          "inbox:i-1":{"id":"i-1","type":"inbox","kind":"pending_intent","lastRefusedByVersion":"1.5.0","failedAt":1700000000002},
          "bad":{"id":"x"}
        }"#,
    );
    let report = import(&vault);
    let rows: Vec<(String, String, String, i64)> = core_conn(&vault)
        .prepare(
            "SELECT item_type, item_id, refused_by_version, refused_at
             FROM sync_refused_items ORDER BY item_type, item_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (
                "inbox".into(),
                "i-1".into(),
                "electron 1.5.0 pending_intent".into(),
                1_700_000_000_002
            ),
            // An older build reads a kind it does not know as `payload`.
            (
                "note".into(),
                "n-1".into(),
                "electron 1.4.0 payload".into(),
                1_700_000_000_001
            ),
            (
                "task".into(),
                "t-1".into(),
                "electron 1.4.0 payload".into(),
                1_700_000_000_000
            ),
        ]
    );
    assert_eq!(report.notices["unreadableSchemaInvalidEntries"], 1);
}

#[test]
fn sync_history_keeps_the_newest_500_with_kind_and_ms() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    let kinds = ["push", "pull", "error"];
    for n in 0..503_i64 {
        let kind = kinds[n as usize % 3];
        electron_db::seed(
            &conn,
            "sync_history",
            &[
                ("id", text(&format!("h-{n}"))),
                ("type", text(kind)),
                ("item_count", Value::Integer(n)),
                (
                    "direction",
                    if kind == "error" {
                        Value::Null
                    } else {
                        text(kind)
                    },
                ),
                ("details", text("d")),
                ("duration_ms", Value::Integer(5)),
                ("created_at", Value::Integer(1_700_000_000 + n)),
            ],
        );
    }
    // A time Electron's schema would not hold sorts first and is not carried.
    electron_db::seed(
        &conn,
        "sync_history",
        &[("type", text("pull")), ("created_at", text("yesterday"))],
    );
    let report = import(&vault);
    let table = &report.tables["data.db/sync_history"];
    assert_eq!((table.source_count, table.target_count), (504, 500));
    assert_eq!(report.dropped["syncHistoryBeyond500"], 3);
    assert_eq!(report.dropped["unreadableSyncHistoryRows"], 1);
    let core = core_conn(&vault);
    let (count, oldest): (i64, i64) = core
        .query_row(
            "SELECT count(*), min(created_at) FROM sync_history",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((count, oldest), (500, 1_700_000_003_000));
    let newest: (String, String, i64, Option<String>, i64) = core
        .query_row(
            "SELECT id, kind, item_count, direction, created_at FROM sync_history
             ORDER BY created_at DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        newest,
        (
            "h-502".into(),
            "pull".into(),
            502,
            Some("pull".into()),
            1_700_000_502_000
        )
    );
}

#[test]
fn an_unknown_sync_state_key_is_reported_not_refused() {
    let vault = Vault::new();
    seed_key(&vault, "fromANewerElectron", "1");
    let report = import(&vault);
    assert_eq!(report.dropped["unknownSyncStateKeys"], 1);
    assert_eq!(report.tables["data.db/sync_state"].dropped, 1);
}

#[test]
fn a_ledger_over_the_cap_fails_before_it_is_parsed() {
    let vault = Vault::new();
    seed_key(
        &vault,
        "schemaInvalidItems",
        &format!("{{\"pad\":\"{}\"}}", "x".repeat(16 * 1024 * 1024)),
    );
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::MalformedRow {
                table: "sync_state",
                ..
            }
        )
    });
}
