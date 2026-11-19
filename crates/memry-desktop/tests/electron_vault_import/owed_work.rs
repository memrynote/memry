//! Stage 36c5: the `sync_state` keys that hold work Electron still owes: a vault-wide CRDT
//! debt (`crdtUnmergedDebt`), owed journal day merges (`journalDayMerge:`) and note cover
//! markers (`note-cover:`). Each imports into its core owner, which acts on it.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use memry_core::api::errors::TransportError;
use memry_core::domain::write_back::{BodyRead, body_for_file};
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::import::{DATA_FILE, document_state};
use memry_core::sync::body_debt;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::journal_day_merge::{self, OwedMerge};
use rusqlite::Connection;
use rusqlite::types::Value;
use serde_json::json;

use super::queue::text;
use super::{Vault, electron_db, import};

fn seed_key(vault: &Vault, key: &str, value: &str, updated_at_s: i64) {
    electron_db::seed(
        &vault.data_conn(),
        "sync_state",
        &[
            ("key", text(key)),
            ("value", text(value)),
            ("updated_at", Value::Integer(updated_at_s)),
        ],
    );
}

/// A markdown row of Electron's `note_metadata`, a journal day when `journal_date` is set.
fn seed_markdown(vault: &Vault, id: &str, path: &str, journal_date: Option<&str>) {
    let mut values = vec![
        ("id", text(id)),
        ("path", text(path)),
        ("title", text(id)),
        ("file_type", text("markdown")),
        ("local_only", Value::Integer(0)),
        ("created_at", text("2026-01-02T03:04:05.000Z")),
        ("modified_at", text("2026-01-03T03:04:05.000Z")),
    ];
    if let Some(date) = journal_date {
        values.push(("journal_date", text(date)));
    }
    electron_db::seed(&vault.data_conn(), "note_metadata", &values);
}

fn core_conn(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

const DEBT_AT_S: i64 = 1_790_000_000;

/// Electron writes the debt on every open of an unmarked store and converts it only at sync
/// start, which a vault that never synced (free, signed out, held) never reaches. Without a
/// record cursor the core's first sync owes every live document itself, so the import owes
/// nothing and write-back stays open.
#[test]
fn a_crdt_debt_of_a_vault_that_never_synced_owes_nothing() {
    let vault = Vault::new();
    seed_markdown(&vault, "n-1", "a.md", None);
    seed_key(&vault, "crdtUnmergedDebt", "1", DEBT_AT_S);
    import(&vault);
    let conn = core_conn(&vault);
    assert!(body_debt::owed(&conn).unwrap().is_empty());
    let read = body_for_file(
        &conn,
        &Converter::new(CalloutTypes::new(Vec::new())),
        "n-1",
        "a.md",
        "",
        &NoEmbeds,
    )
    .unwrap();
    assert!(
        !matches!(read, BodyRead::BodyNotPulled | BodyRead::NoNote),
        "{read:?}"
    );
}

#[test]
fn a_legacy_crdt_debt_of_a_synced_vault_owes_every_note_and_journal_body() {
    let vault = Vault::new();
    seed_key(&vault, "lastCursor", "42", DEBT_AT_S);
    seed_markdown(&vault, "n-1", "a.md", None);
    seed_markdown(&vault, "n-2", "b.md", None);
    seed_markdown(
        &vault,
        "j2026-01-05",
        "journal/2026-01-05.md",
        Some("2026-01-05"),
    );
    seed_key(&vault, "crdtUnmergedDebt", "1", DEBT_AT_S);
    // A conversion recorded at another time is another row's: this one was never converted.
    seed_key(&vault, "crdtBodyDebtMirrorAt", "1789999999000", DEBT_AT_S);
    let report = import(&vault);
    // The body step pulls what `owed` lists, and the snapshot push refuses every owed document.
    assert_eq!(
        body_debt::owed(&core_conn(&vault)).unwrap(),
        ["j2026-01-05", "n-1", "n-2"]
    );
    assert_eq!(report.tables["data.db/sync_state"].target_count, 2);
}

#[test]
fn a_crdt_debt_electron_already_converted_owes_nothing_again() {
    // `convertUnmergedDebtMirror` records the row's `updated_at` (`Date#getTime`) once converted.
    for (value, mirror_at) in [("1", Some("1790000000000")), ("0", None)] {
        let vault = Vault::new();
        seed_key(&vault, "lastCursor", "42", DEBT_AT_S);
        seed_markdown(&vault, "n-1", "a.md", None);
        seed_key(&vault, "crdtUnmergedDebt", value, DEBT_AT_S);
        if let Some(at) = mirror_at {
            seed_key(&vault, "crdtBodyDebtMirrorAt", at, DEBT_AT_S);
        }
        import(&vault);
        assert!(
            body_debt::owed(&core_conn(&vault)).unwrap().is_empty(),
            "{value} {mirror_at:?}"
        );
    }
}

fn owed_day(foreign: &str, value: serde_json::Value) -> (String, String) {
    (format!("journalDayMerge:{foreign}"), value.to_string())
}

#[test]
fn owed_journal_day_merges_are_carried_with_this_devices_text() {
    let vault = Vault::new();
    for (key, value) in [
        // A foreign holder that gave the day up: its file text only lives here.
        owed_day(
            "f-held",
            json!({"foreignId": "f-held", "date": "2026-02-01", "clock": {"dev-A": 2},
                   "fallbackMarkdown": "My unpushed day", "recordMarkdown": "Their copy",
                   "deleted": true}),
        ),
        // Seen on a pull, never synced here: `clock` null, explicit nulls from the spread.
        owed_day(
            "f-pulled",
            json!({"foreignId": "f-pulled", "date": "2026-02-02", "clock": null,
                   "fallbackMarkdown": null, "recordMarkdown": "Pulled text"}),
        ),
        owed_day("f-bad", json!({"date": "2026-02-03"})),
        ("journalDayMerge:f-text".into(), "not json".into()),
    ] {
        seed_key(&vault, &key, &value, DEBT_AT_S);
    }
    let report = import(&vault);
    assert_eq!(report.dropped["unreadableJournalDayMerges"], 2);
    assert_eq!(
        journal_day_merge::owed(&core_conn(&vault)).unwrap(),
        vec![
            OwedMerge {
                foreign_id: "f-held".into(),
                date: "2026-02-01".into(),
                clock: BTreeMap::from([("dev-A".to_owned(), 2)]),
                deleted: true,
                record_markdown: Some("Their copy".into()),
                fallback_markdown: Some("My unpushed day".into()),
            },
            OwedMerge {
                foreign_id: "f-pulled".into(),
                date: "2026-02-02".into(),
                clock: BTreeMap::new(),
                deleted: false,
                record_markdown: Some("Pulled text".into()),
                fallback_markdown: None,
            },
        ]
    );
}

/// No request is expected: a deleted foreign id is not pulled, and the other merge waits.
struct Offline;

#[async_trait::async_trait]
impl Transport for Offline {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        Err(TransportError::Offline)
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Offline)
    }
}

struct NoBodies;

impl CrdtCipher for NoBodies {
    fn open(&self, _update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// Electron folds a foreign day's own text into `j<D>` even when another device deleted the
/// foreign id (`journal-day-merge.ts:210-220`); the core's first drain does the same.
#[test]
fn the_first_drain_folds_this_devices_text_of_a_deleted_foreign_day() {
    let vault = Vault::new();
    let (key, value) = owed_day(
        "f-held",
        json!({"foreignId": "f-held", "date": "2026-02-01", "clock": {"dev-A": 2},
               "fallbackMarkdown": "My unpushed day", "deleted": true}),
    );
    seed_key(&vault, &key, &value, DEBT_AT_S);
    import(&vault);

    let path = vault.core().join(DATA_FILE);
    let db = memry_core::storage::open_data(&path).unwrap();
    let http = HttpClient::new(
        Arc::new(Offline) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").unwrap(),
    );
    let bodies = BodyPull::new(
        Arc::new(http),
        db.clone(),
        Declaration::desktop(),
        Arc::new(NoBodies),
    );
    let report = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(journal_day_merge::drain(&db, &bodies, "device-tauri"))
        .unwrap();
    assert_eq!(report.settled, ["f-held"]);
    let day = document_state(&path, "j2026-02-01")
        .unwrap()
        .expect("the day");
    assert!(day.text.contains("My unpushed day"), "{}", day.text);
}

/// `noteCoverForPush`: a note whose cover this device held and whose file has none pushes
/// `cover: null`. The `note_metadata` importer reads the marker into that payload.
#[test]
fn a_cover_marker_carries_the_removal_in_the_note_payload() {
    let vault = Vault::new();
    for id in ["n-removed", "n-never"] {
        seed_markdown(&vault, id, &format!("{id}.md"), None);
        std::fs::write(vault.root.join(format!("{id}.md")), "# Plain\n").unwrap();
    }
    seed_key(&vault, "note-cover:n-removed", "removal-pending", DEBT_AT_S);
    let report = import(&vault);
    assert_eq!(report.dropped["note-cover:"], 1);
    let payloads: HashMap<String, serde_json::Value> = core_conn(&vault)
        .prepare("SELECT item_id, payload FROM sync_items WHERE item_type = 'note'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get::<_, String>(1)?)))
        .unwrap()
        .map(|row| {
            let (id, payload) = row.unwrap();
            (id, serde_json::from_str(&payload).unwrap())
        })
        .collect();
    assert_eq!(payloads["n-removed"]["cover"], serde_json::Value::Null);
    assert_eq!(payloads["n-removed"]["coverImage"], serde_json::Value::Null);
    assert!(payloads["n-removed"].get("cover").is_some());
    assert!(payloads["n-never"].get("cover").is_none());
}
