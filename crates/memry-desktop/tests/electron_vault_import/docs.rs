//! Stage 36c4: the folded Yjs documents, their queued body pushes, the body sync state, the body
//! debts, and the `note_files` hashes that let the first write-back put a body ahead of its file.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::crdt::DocumentRegistry;
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::{FoldedDoc, VaultImportInput, stage_vault_import};
use memry_desktop::vault::hash::content_hash;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::queue::{queue, seed_note, text};
use super::{NOW_MS, Vault, assert_refused, electron_db, staged};

const NOTE: &str = "Doc-note0001";
const PATH: &str = "Doc.md";
/// What `seed_note` writes to the note's file.
const FILE: &str = "---\ntags: daily\n---\n\nToday.\n\n";

/// A Yjs document whose body is `markdown`, encoded as one update.
pub(super) fn doc_state(id: &str, markdown: &str) -> Vec<u8> {
    let doc = DocumentRegistry::new("electron", Arc::new(|_: &str, _: &[u8]| {}))
        .get_or_open(id)
        .unwrap();
    assert!(
        Converter::new(CalloutTypes::new(Vec::new()))
            .seed_body(&doc, markdown, None, None, &NoEmbeds)
    );
    doc.encode_state().unwrap()
}

pub(super) fn folded(id: &str, markdown: &str, watermark: Option<u64>) -> FoldedDoc {
    FoldedDoc {
        doc_id: id.into(),
        state: doc_state(id, markdown),
        watermark,
    }
}

/// Electron's `note_cache` row of a note whose file it last read as `read`.
pub(super) fn cache(vault: &Vault, id: &str, path: &str, read: &str) {
    electron_db::seed(
        &Connection::open(&vault.pair.index).unwrap(),
        "note_cache",
        &[
            ("id", text(id)),
            ("path", text(path)),
            ("content_hash", text(&content_hash(read))),
        ],
    );
}

fn input(vault: &Vault, docs: Vec<FoldedDoc>) -> VaultImportInput<'_> {
    VaultImportInput {
        docs,
        ..vault.input()
    }
}

fn import_docs(
    vault: &Vault,
    docs: Vec<FoldedDoc>,
) -> memry_desktop::electron_import::vault_db::VaultStageReport {
    let staged = staged(stage_vault_import(input(vault, docs)).unwrap());
    let report = staged.report().clone();
    staged.install().unwrap();
    report
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

/// `(item_type, item_id, op, payload)` of every outbox row, in queue order.
fn outbox(core: &Connection) -> Vec<(String, String, String, Vec<u8>)> {
    let mut stmt = core
        .prepare("SELECT item_type, item_id, op, coalesce(payload, x'') FROM outbox ORDER BY id")
        .unwrap();
    stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

/// `(content_hash, file_hash, indexed_at)` of the note's row.
fn hashes(core: &Connection, id: &str) -> (Option<String>, Option<String>, i64) {
    core.query_row(
        "SELECT f.content_hash, h.file_hash, f.indexed_at
           FROM note_files f LEFT JOIN note_file_hashes h USING (note_id) WHERE f.note_id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap()
}

fn body(id: &str, payload: &str, at: i64) -> (String, String, String) {
    (id.to_owned(), payload.to_owned(), at.to_string())
}

fn queue_bodies(vault: &Vault, rows: &[(String, String, String)]) {
    for (id, payload, at) in rows {
        queue(
            &vault.data_conn(),
            "note_body",
            id,
            "update",
            payload,
            at.parse().unwrap(),
        );
    }
}

#[test]
fn a_document_imports_as_local_update_one_with_its_cursor() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    cache(&vault, NOTE, PATH, FILE);
    let doc = folded(NOTE, "Today.\n", Some(42));
    let state = doc.state.clone();
    let staged = staged(stage_vault_import(input(&vault, vec![doc])).unwrap());
    let read = staged.document_state(NOTE).unwrap().unwrap();
    assert!(read.text.contains("text \"Today.\""), "{}", read.text);
    assert_eq!(staged.document_state("no-such-doc").unwrap(), None);
    staged.install().unwrap();

    let core = installed(&vault);
    let log: Vec<(String, i64, Vec<u8>, i64)> = core
        .prepare("SELECT doc_id, seq, update_blob, created_at FROM yjs_updates")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(log, vec![(format!("local.{NOTE}"), 1, state, NOW_MS)]);
    let cursor: String = core
        .query_row(
            "SELECT cursor FROM sync_cursors WHERE scope = ?1",
            [format!("crdt:{NOTE}")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, "42");
    assert_eq!(outbox(&core), Vec::new());
}

/// The body serializes to the file: the row holds the file, stamped after the document, so no
/// write-back is owed.
#[test]
fn a_body_equal_to_its_file_records_the_file_hash() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    std::fs::write(vault.root.join(PATH), "Today.\r\n\n").unwrap();
    cache(&vault, NOTE, PATH, "Today.\r\n\n");
    import_docs(&vault, vec![folded(NOTE, "Today.\n", None)]);
    let core = installed(&vault);
    let on_disk = content_hash("Today.\r\n\n");
    assert_eq!(
        hashes(&core, NOTE),
        (Some(on_disk.clone()), Some(on_disk), NOW_MS)
    );
    assert_eq!(
        memry_core::domain::note_files::behind_bodies(&core).unwrap(),
        Vec::<String>::new()
    );
}

/// The body holds text the file Electron last read does not: the row names that file and is
/// stamped before the document, so the first write-back writes the body.
#[test]
fn a_body_ahead_of_its_file_is_stamped_behind_its_document() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    cache(&vault, NOTE, PATH, FILE);
    import_docs(&vault, vec![folded(NOTE, "Tomorrow.\n", None)]);
    let core = installed(&vault);
    let on_disk = content_hash(FILE);
    assert_eq!(
        hashes(&core, NOTE),
        (Some(on_disk.clone()), Some(on_disk), NOW_MS - 1)
    );
    assert_eq!(
        memry_core::domain::note_files::behind_bodies(&core).unwrap(),
        vec![NOTE.to_owned()]
    );
}

/// A file Electron never read, and a file that owes its body to the document, are never written
/// over: the row keeps no hash.
#[test]
fn an_unread_or_owed_file_keeps_no_hash() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    seed_note(&vault, "Owed-note001", "Owed.md", None, false);
    cache(&vault, "Owed-note001", "Owed.md", FILE);
    electron_db::seed(
        &vault.data_conn(),
        "crdt_owed_file_bodies",
        &[
            ("note_id", text("Owed-note001")),
            ("created_at", Value::Integer(123)),
        ],
    );
    import_docs(
        &vault,
        vec![
            folded(NOTE, "Tomorrow.\n", None),
            folded("Owed-note001", "Tomorrow.\n", None),
        ],
    );
    let core = installed(&vault);
    assert_eq!(hashes(&core, NOTE).0, None);
    assert_eq!(hashes(&core, "Owed-note001").0, None);
    assert_eq!(
        memry_core::domain::owed_file_body::recorded_at(&core, "Owed-note001").unwrap(),
        Some(123)
    );
}

/// Each `note_body` row is one CRDT outbox row, in Electron's order and never collapsed; an
/// empty payload owes the whole state. A local-only note's row is dropped and counted.
#[test]
fn queued_body_pushes_become_crdt_outbox_rows_in_order() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    seed_note(&vault, "Local-note01", "Local.md", None, true);
    let doc = folded(NOTE, "Today.\n", None);
    let full = doc.state.clone();
    let update = doc_state("other", "Delta.\n");
    queue_bodies(
        &vault,
        &[
            body(NOTE, &STANDARD.encode(&update), 10),
            body(NOTE, "", 11),
            body(NOTE, &STANDARD.encode(&update), 12),
            body("Local-note01", "", 13),
        ],
    );
    let report = import_docs(&vault, vec![doc, folded("Local-note01", "Local.\n", None)]);
    let queue = &report.tables["data.db/sync_queue"];
    assert_eq!(queue.target_count, 3);
    assert_eq!(queue.dropped, 1);
    assert_eq!(report.dropped.get("localOnlyBodyRows"), Some(&1));
    let crdt = |payload: &[u8]| {
        (
            "note".into(),
            NOTE.into(),
            "crdt-update".into(),
            payload.to_vec(),
        )
    };
    let core = installed(&vault);
    assert_eq!(
        outbox(&core),
        vec![crdt(&update), crdt(&full), crdt(&update)]
    );
    // `sync_queue.created_at` is epoch seconds; the outbox keeps ms.
    let enqueued: Vec<i64> = core
        .prepare("SELECT enqueued_at FROM outbox ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(enqueued, [10_000, 11_000, 12_000]);
}

/// A push sent and never confirmed is queued again as the whole state; the table is copied and
/// `pushed_state_vector` is counted, not kept.
#[test]
fn an_in_flight_body_push_is_queued_again_as_the_full_state() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    seed_note(&vault, "Done-note001", "Done.md", None, false);
    for (id, sent, confirmed) in [
        (NOTE, 200, Value::Integer(100)),
        ("Done-note001", 100, Value::Integer(200)),
    ] {
        electron_db::seed(
            &vault.data_conn(),
            "note_body_sync",
            &[
                ("note_id", text(id)),
                ("last_sent_at", Value::Integer(sent)),
                ("last_confirmed_at", confirmed),
                ("pushed_state_vector", text("AAE=")),
                ("updated_at", Value::Integer(300)),
            ],
        );
    }
    let doc = folded(NOTE, "Today.\n", None);
    let full = doc.state.clone();
    let report = import_docs(&vault, vec![doc, folded("Done-note001", "Done.\n", None)]);
    let table = &report.tables["data.db/note_body_sync"];
    assert_eq!(table.target_count, 2);
    assert_eq!(report.notices.get("inFlightBodyPushes"), Some(&1));
    assert_eq!(report.notices.get("pushedStateVectors"), Some(&2));
    let core = installed(&vault);
    assert_eq!(
        outbox(&core),
        vec![("note".into(), NOTE.into(), "crdt-update".into(), full)]
    );
    let sent: (i64, i64) = core
        .query_row(
            "SELECT last_sent_at, last_confirmed_at FROM note_body_sync WHERE note_id = ?1",
            [NOTE],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(sent, (200, 100));
}

#[test]
fn body_debts_withheld_bodies_and_extra_owed_documents_are_owed() {
    let vault = Vault::new();
    let data = vault.data_conn();
    electron_db::seed(
        &data,
        "crdt_body_debts",
        &[
            ("note_id", text("Debt-note001")),
            ("failures", Value::Integer(3)),
        ],
    );
    electron_db::seed(
        &data,
        "crdt_body_withheld",
        &[("note_id", text("Held-note001"))],
    );
    drop(data);
    let staged = staged(
        stage_vault_import(VaultImportInput {
            extra_owed_docs: vec!["Extra-doc001".into()],
            ..vault.input()
        })
        .unwrap(),
    );
    staged.install().unwrap();
    let mut owed = memry_core::sync::body_debt::owed(&installed(&vault)).unwrap();
    owed.sort();
    assert_eq!(owed, ["Debt-note001", "Extra-doc001", "Held-note001"]);
}

/// A queued body push whose document the store copy does not hold has no state to send.
#[test]
fn a_body_push_without_its_document_is_refused() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    queue_bodies(&vault, &[body(NOTE, "", 10)]);
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::OrphanBodyQueueRow { doc_ids } if doc_ids == &[NOTE.to_owned()]),
    );
}

/// A push of a document no note, journal day or synced item owns would reach the wrong owner
/// under a guessed type.
#[test]
fn a_body_push_of_no_known_item_is_refused() {
    let vault = Vault::new();
    queue_bodies(&vault, &[body(NOTE, "", 10)]);
    let error = stage_vault_import(input(&vault, vec![folded(NOTE, "Today.\n", None)]))
        .err()
        .expect("refused");
    assert!(
        matches!(&error, ImportError::Storage(e) if e.to_string().contains(NOTE)),
        "{error}"
    );
    assert!(!vault.staging().exists());
    assert!(!vault.core().exists());
}

/// Electron writes `Buffer.toString('base64')`: padded standard base64. Anything else is a
/// damaged row, refused rather than decoded leniently.
#[test]
fn a_body_payload_that_is_not_strict_base64_is_refused() {
    for payload in ["QQ", "QQ==\n", "-_8=", "not base64!"] {
        let vault = Vault::new();
        seed_note(&vault, NOTE, PATH, None, false);
        queue_bodies(&vault, &[body(NOTE, payload, 10)]);
        let error = stage_vault_import(input(&vault, vec![folded(NOTE, "Today.\n", None)]))
            .err()
            .expect("refused");
        assert!(
            matches!(
                error,
                ImportError::MalformedRow {
                    table: "sync_queue",
                    what: "a note_body payload is not base64",
                    ..
                }
            ),
            "{payload}: {error}"
        );
        assert!(!vault.staging().exists());
        assert!(!vault.core().exists());
    }
}

/// Electron's sync row outlives the note it pushed for: an in-flight push of a gone note is
/// skipped and counted, and the vault imports.
#[test]
fn an_in_flight_push_of_a_gone_note_is_skipped_and_counted() {
    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "note_body_sync",
        &[
            ("note_id", text("Gone-note001")),
            ("last_sent_at", Value::Integer(200)),
            ("updated_at", Value::Integer(300)),
        ],
    );
    let report = import_docs(&vault, vec![folded("Gone-note001", "Gone.\n", None)]);
    assert_eq!(report.notices.get("goneInFlightBodyPushes"), Some(&1));
    assert_eq!(report.notices.get("inFlightBodyPushes"), None);
    assert_eq!(outbox(&installed(&vault)), Vec::new());
}

/// The file changed since Electron read it: the row names the file Electron read, stamped as
/// holding the body, so the consumer feeds the edit; the body is a version first.
#[test]
fn a_file_edited_since_electron_read_it_is_fed_with_the_body_kept() {
    let vault = Vault::new();
    seed_note(&vault, NOTE, PATH, None, false);
    cache(&vault, NOTE, PATH, "---\ntags: [a]\n---\n\nYesterday.\n");
    import_docs(&vault, vec![folded(NOTE, "Yesterday.\n", None)]);
    let core = installed(&vault);
    assert_eq!(
        hashes(&core, NOTE),
        (
            Some(content_hash("---\ntags: [a]\n---\n\nYesterday.\n")),
            Some(content_hash(FILE)),
            NOW_MS
        )
    );
    let versions: Vec<(String, String)> = core
        .prepare("SELECT content, reason FROM note_snapshots WHERE note_id = ?1")
        .unwrap()
        .query_map([NOTE], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(versions.len(), 1, "{versions:?}");
    assert!(
        versions[0].0.starts_with("---\ntags: daily\n---\n"),
        "{versions:?}"
    );
    assert!(versions[0].0.contains("Yesterday."), "{versions:?}");
    assert_eq!(versions[0].1, "significant");
    assert_eq!(
        memry_core::domain::note_files::behind_bodies(&core).unwrap(),
        Vec::<String>::new()
    );
}

/// The newest stamp of the note's own body log, as delete-keep rule 3 reads it.
fn last_local_body_at(core: &Connection, id: &str) -> Option<i64> {
    core.query_row(
        "SELECT MAX(at) FROM (
           SELECT MAX(created_at) AS at FROM yjs_updates WHERE doc_id = ?1
           UNION ALL SELECT compacted_at FROM yjs_snapshots WHERE doc_id = ?1)",
        [format!("local.{id}")],
        |row| row.get(0),
    )
    .unwrap()
}

/// A remote delete made a day before the import, of a note whose body holds no text the file
/// lacks, is applied and not kept: the imported body is stamped at Electron's
/// `last_confirmed_at`, or before every delete when Electron confirmed none
/// (`keep-unseen-text.ts:65`). A body ahead of its file is this device's unseen text.
#[test]
fn a_remote_delete_before_the_import_is_applied_not_kept() {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    let vault = Vault::new();
    for (id, path) in [
        (NOTE, PATH),
        ("Never-conf01", "Never.md"),
        ("Ahead-note01", "Ahead.md"),
    ] {
        seed_note(&vault, id, path, None, false);
        std::fs::write(vault.root.join(path), "Today.\n").unwrap();
        cache(&vault, id, path, "Today.\n");
    }
    electron_db::seed(
        &vault.data_conn(),
        "note_body_sync",
        &[
            ("note_id", text(NOTE)),
            ("last_sent_at", Value::Integer(NOW_MS - 3 * DAY_MS)),
            ("last_confirmed_at", Value::Integer(NOW_MS - 2 * DAY_MS)),
            ("updated_at", Value::Integer(NOW_MS - 2 * DAY_MS)),
        ],
    );
    import_docs(
        &vault,
        vec![
            folded(NOTE, "Today.\n", None),
            folded("Never-conf01", "Today.\n", None),
            folded("Ahead-note01", "Tomorrow.\n", None),
        ],
    );
    let core = installed(&vault);
    let keeps = |id: &str| {
        memry_core::sync::delete_keep::keeps_unseen_text(
            &memry_core::sync::delete_keep::UnseenTextFacts {
                body_blank: false,
                waiting_changes: false,
                local_clock: None,
                tombstone_clock: None,
                deleted_at: Some((NOW_MS - DAY_MS) / 1000),
                last_local_body_at: last_local_body_at(&core, id),
                deleter_body_state_vector: None,
                local_body_state_vector: None,
            },
        )
    };
    assert_eq!(last_local_body_at(&core, NOTE), Some(NOW_MS - 2 * DAY_MS));
    assert!(!keeps(NOTE));
    assert_eq!(last_local_body_at(&core, "Never-conf01"), Some(0));
    assert!(!keeps("Never-conf01"));
    assert_eq!(last_local_body_at(&core, "Ahead-note01"), Some(NOW_MS));
    assert!(keeps("Ahead-note01"));
}
