//! Stage 36c5: the `sync_state` keys that hold work Electron still owes: a vault-wide CRDT
//! debt (`crdtUnmergedDebt`), owed journal day merges (`journalDayMerge:`) and note cover
//! markers (`note-cover:`). Each imports into its core owner, which acts on it.

use std::collections::{BTreeMap, HashMap};

use memry_core::domain::write_back::{BodyRead, body_for_file};
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::import::{DATA_FILE, document_state};
use memry_core::sync::body_debt;
use memry_core::sync::journal_day_merge::{self, OwedMerge};
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::{FoldedDoc, VaultImportInput, stage_vault_import};
use rusqlite::Connection;
use rusqlite::types::Value;
use serde_json::json;

use super::docs::folded;
use super::queue::text;
use super::{Vault, electron_db, import, staged, written_by_import};

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
        Some(""),
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

/// Owed merges whose fold needs nothing of this device's: a record seen on a pull, a deleted
/// id whose holder tags a tombstone weighed to none, and a blank holder snapshot.
#[test]
fn owed_journal_day_merges_that_need_nothing_local_are_carried() {
    let vault = Vault::new();
    for (key, value) in [
        owed_day(
            "f-weighed",
            json!({"foreignId": "f-weighed", "date": "2026-02-01", "clock": {"dev-A": 2},
                   "fallbackMarkdown": "  \n", "recordMarkdown": "Their copy",
                   "deleted": true, "tags": ["mine"], "unpushedTags": [],
                   "recordTags": ["theirs"], "holderClock": {"dev-A": 2}}),
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
    let staged = staged(
        stage_vault_import(VaultImportInput {
            // An empty doc holds no state (`hasDocState`).
            docs: vec![FoldedDoc {
                doc_id: "f-pulled".into(),
                state: vec![0, 0],
                watermark: None,
            }],
            ..vault.input()
        })
        .unwrap(),
    );
    let report = staged.report().clone();
    staged.install().unwrap();
    assert_eq!(report.dropped["unreadableJournalDayMerges"], 2);
    assert_eq!(
        journal_day_merge::owed(&core_conn(&vault)).unwrap(),
        vec![
            OwedMerge {
                foreign_id: "f-pulled".into(),
                date: "2026-02-02".into(),
                clock: BTreeMap::new(),
                deleted: false,
                record_markdown: Some("Pulled text".into()),
                record_tags: Vec::new(),
                holder_tags: Vec::new(),
                unpushed_holder_tags: Vec::new(),
            },
            OwedMerge {
                foreign_id: "f-weighed".into(),
                date: "2026-02-01".into(),
                clock: BTreeMap::from([("dev-A".to_owned(), 2)]),
                deleted: true,
                record_markdown: Some("Their copy".into()),
                record_tags: vec!["theirs".into()],
                holder_tags: vec!["mine".into()],
                unpushed_holder_tags: Vec::new(),
            },
        ]
    );
    let conn = core_conn(&vault);
    let held: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_items WHERE item_id IN ('f-weighed', 'f-pulled')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(held, 0);
}

/// The vault the refusal asks for: Electron drained the merge, so the day holds this device's
/// text as `j<D>` and no owed row is left. It imports.
#[test]
fn a_vault_whose_day_merges_are_drained_imports() {
    let vault = Vault::new();
    seed_markdown(
        &vault,
        "j2026-02-01",
        "journal/2026-02-01.md",
        Some("2026-02-01"),
    );
    let staged = staged(
        stage_vault_import(VaultImportInput {
            docs: vec![folded("j2026-02-01", "My unpushed day\n", None)],
            ..vault.input()
        })
        .unwrap(),
    );
    staged.install().unwrap();
    let day = document_state(&vault.core().join(DATA_FILE), "j2026-02-01")
        .unwrap()
        .expect("the day");
    assert!(day.text.contains("My unpushed day"), "{}", day.text);
    assert!(
        journal_day_merge::owed(&core_conn(&vault))
            .unwrap()
            .is_empty()
    );
}

fn assert_refused_for(vault: &Vault, docs: Vec<FoldedDoc>, foreign: &str) {
    let error = match stage_vault_import(VaultImportInput {
        docs,
        ..vault.input()
    }) {
        Err(error) => error,
        Ok(_) => panic!("the import was not refused"),
    };
    assert!(
        matches!(&error, ImportError::UndrainedJournalDay { foreign_ids } if foreign_ids == &[foreign]),
        "{error:?}"
    );
    assert!(
        error
            .to_string()
            .contains("Open the previous MemryNote app")
    );
    assert_eq!(written_by_import(vault), Vec::<String>::new());
    assert!(!vault.staging().exists());
}

/// An owed merge whose fold needs this device's state of the foreign day is refused before any
/// write. Each row is a reviewer's repro of a holder the core would lose or push: VERIFY-5166B 1
/// (text, tombstone before the drain), B 2 (tags under a covering tombstone), C and D (an
/// unclocked holder seeded, a clocked one reuploaded), a deleted id's text (#2984), unweighed
/// tags of a deleted id, and attachment references (OL-M47).
#[test]
fn an_owed_merge_that_needs_this_devices_day_is_refused() {
    for value in [
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "fallbackMarkdown": "My unpushed day"}),
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "tags": ["removed-elsewhere"], "holderClock": {"dev-A": 2}}),
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "fallbackMarkdown": "My unpushed day", "tags": ["t"]}),
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "fallbackMarkdown": "My unpushed day", "deleted": true}),
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "deleted": true, "tags": ["t"]}),
        json!({"foreignId": "f", "date": "2026-02-01", "clock": {"dev-A": 2},
               "attachmentReferences": ["att-1"]}),
    ] {
        let vault = Vault::new();
        let (key, value) = owed_day("f", value);
        seed_key(&vault, &key, &value, DEBT_AT_S);
        assert_refused_for(&vault, Vec::new(), "f");
    }
}

/// A foreign doc with local Yjs state is folded by Electron's drain, deleted id or not
/// (`absorbBody`); without its row a tombstone in the core would purge it first.
#[test]
fn an_owed_merge_whose_foreign_doc_holds_state_is_refused() {
    let vault = Vault::new();
    let (key, value) = owed_day(
        "f-doc",
        json!({"foreignId": "f-doc", "date": "2026-02-01", "clock": {"dev-A": 2},
               "deleted": true}),
    );
    seed_key(&vault, &key, &value, DEBT_AT_S);
    assert_refused_for(
        &vault,
        vec![folded("f-doc", "Typed offline\n", None)],
        "f-doc",
    );
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
