//! Stage 36c2: what Electron would queue at its next sync start. Its pending deletes
//! (`flushPendingLocalDeletes`) and the dirty sweeps of `dirty-recovery.ts` reach the core outbox
//! as Electron queues them. The rows that never had a clock are staged unclocked and unqueued,
//! and the core pass seeds them after its pull (`seedUnclocked`, `unclocked_seed`).

use memry_core::domain::unclocked_seed;
use memry_core::storage::import::DATA_FILE;
use memry_core::storage::open_data;
use memry_desktop::electron_import::ImportError;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::queue::{queue, rows, seed_folder, text};
use super::{ELECTRON_DEVICE, NOW_MS, Vault, assert_refused, electron_db, import};

const CREATED: &str = "2026-01-05T08:00:00.000Z";
const MODIFIED: &str = "2026-01-05T09:00:00.000Z";
const CORE_DEVICE: &str = "device-core";

fn core(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

/// The staged outbox, sorted.
fn outbox(core: &Connection) -> Vec<(String, String, String)> {
    let mut rows = rows(core, "SELECT item_type, item_id, op FROM outbox");
    rows.sort();
    rows
}

fn owned(rows: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect()
}

/// `(payload, clock, deleted_at)` of one `sync_items` row.
fn item(core: &Connection, item_type: &str, id: &str) -> (String, Option<String>, Option<i64>) {
    core.query_row(
        "SELECT payload, clock, deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        [item_type, id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn opt(value: Option<&str>) -> Value {
    value.map_or(Value::Null, text)
}

/// One `sync_pending_deletes` row, `created_at` in epoch seconds.
fn pending(conn: &Connection, item_type: &str, id: &str, payload: &str, at: i64) {
    electron_db::seed(
        conn,
        "sync_pending_deletes",
        &[
            ("type", text(item_type)),
            ("item_id", text(id)),
            ("payload", text(payload)),
            ("created_at", Value::Integer(at)),
        ],
    );
}

fn delete_clock(conn: &Connection, item_type: &str, id: &str, clock: &str) {
    electron_db::seed(
        conn,
        "sync_tombstone_clocks",
        &[
            ("type", text(item_type)),
            ("item_id", text(id)),
            ("clock", text(clock)),
            ("updated_at", Value::Integer(1_767_000_000)),
        ],
    );
}

struct Note<'a> {
    id: &'a str,
    journal_date: Option<&'a str>,
    clock: Option<&'a str>,
    synced_at: Option<&'a str>,
    local_only: bool,
}

fn note(id: &str) -> Note<'_> {
    Note {
        id,
        journal_date: None,
        clock: Some(r#"{"dev-A":5}"#),
        synced_at: Some("2026-01-05T10:00:00.000Z"),
        local_only: false,
    }
}

fn seed_note(vault: &Vault, note: &Note<'_>) {
    let path = format!("{}.md", note.id);
    electron_db::seed(
        &vault.data_conn(),
        "note_metadata",
        &[
            ("id", text(note.id)),
            ("path", text(&path)),
            ("title", text(note.id)),
            ("journal_date", opt(note.journal_date)),
            ("local_only", Value::Integer(i64::from(note.local_only))),
            ("clock", opt(note.clock)),
            ("synced_at", opt(note.synced_at)),
            ("created_at", text(CREATED)),
            ("modified_at", text(MODIFIED)),
        ],
    );
    std::fs::create_dir_all(&vault.root).unwrap();
    std::fs::write(vault.root.join(path), "Body.\n").unwrap();
}

fn seed_template(conn: &Connection, id: &str, clock: Option<&str>, synced_at: Option<&str>) {
    electron_db::seed(
        conn,
        "templates",
        &[
            ("id", text(id)),
            ("name", text("Meeting")),
            ("clock", opt(clock)),
            ("synced_at", opt(synced_at)),
            ("created_at", text(CREATED)),
            ("modified_at", text(MODIFIED)),
        ],
    );
}

fn seed_tag_category(conn: &Connection, id: &str, clock: Option<&str>) {
    electron_db::seed(
        conn,
        "tag_categories",
        &[
            ("id", text(id)),
            ("name", text("Work")),
            ("sort_order", Value::Integer(0)),
            ("clock", opt(clock)),
            ("created_at", text(CREATED)),
            ("updated_at", text(MODIFIED)),
        ],
    );
}

fn seed_unclocked_folder(conn: &Connection, path: &str) {
    electron_db::seed(
        conn,
        "folder_configs",
        &[
            ("path", text(path)),
            ("created_at", text(CREATED)),
            ("modified_at", text(MODIFIED)),
        ],
    );
}

fn seed_property(conn: &Connection, name: &str, kind: &str) {
    electron_db::seed(
        conn,
        "property_definitions",
        &[
            ("name", text(name)),
            ("type", text(kind)),
            ("created_at", text(CREATED)),
        ],
    );
}

/// #2423: a pending delete of a re-creatable id that is live again is stale, and the live row
/// is what the user has. A tag category keeps a soft-deleted row under its id, which says
/// nothing about a re-create, so its delete is replayed.
#[test]
fn only_a_recreatable_type_drops_a_pending_delete_of_a_live_id() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_folder(&data, "Projects");
    pending(
        &data,
        "folder_config",
        "Projects",
        r#"{"path":"Projects","clock":{"dev-A":2}}"#,
        100,
    );
    seed_tag_category(&data, "cat-1", Some(r#"{"dev":1}"#));
    pending(
        &data,
        "tag_category",
        "cat-1",
        r#"{"id":"cat-1","clock":{"dev":1}}"#,
        200,
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.dropped.get("stalePendingDeletes"), Some(&1));
    let table = &report.tables["data.db/sync_pending_deletes"];
    assert_eq!((table.target_count, table.dropped), (1, 1));
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[("tag_category", "cat-1", "delete")]));
    assert_eq!(item(&core, "folder_config", "Projects").2, None);
    let tombstone = r#"{"id":"cat-1","clock":{"dev":1,"device-electron":1}}"#;
    assert_eq!(
        item(&core, "tag_category", "cat-1"),
        (
            tombstone.to_owned(),
            Some(r#"{"dev":1,"device-electron":1}"#.to_owned()),
            Some(200_000)
        )
    );
}

/// `RecordSyncController.enqueueDelete` ticks the snapshot's clock once under the device
/// (`withIncrementedClock`); a re-creatable type records the ticked clock as its delete clock.
#[test]
fn a_pending_snapshot_delete_is_ticked_under_the_electron_device() {
    let vault = Vault::new();
    let data = vault.data_conn();
    pending(
        &data,
        "folder_config",
        "Gone",
        r#"{"path":"Gone","icon":"star","clock":{"dev-A":3}}"#,
        300,
    );
    pending(
        &data,
        "template",
        "tpl-x",
        r#"{"id":"tpl-x","clock":{"dev-A":1}}"#,
        310,
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = core(&vault);
    assert_eq!(
        outbox(&core),
        owned(&[
            ("folder_config", "Gone", "delete"),
            ("template", "tpl-x", "delete")
        ])
    );
    let ticked = r#"{"dev-A":3,"device-electron":1}"#;
    assert_eq!(
        item(&core, "folder_config", "Gone"),
        (
            format!(r#"{{"path":"Gone","icon":"star","clock":{ticked}}}"#),
            Some(ticked.to_owned()),
            Some(300_000)
        )
    );
    assert_eq!(
        item(&core, "template", "tpl-x").0,
        r#"{"id":"tpl-x","clock":{"dev-A":1,"device-electron":1}}"#
    );
    let clocks: Vec<(String, String, String)> = rows(
        &core,
        "SELECT item_type, item_id, clock FROM sync_tombstone_clocks ORDER BY item_type",
    );
    assert_eq!(clocks, owned(&[("folder_config", "Gone", ticked)]));
}

/// Notes and journals replay the body captured at delete time as is (`enqueueRecoveredDelete`);
/// one without a clock is stamped as Electron's push does (`ensureRequiredClock`).
#[test]
fn a_pending_note_delete_is_pushed_with_its_captured_body() {
    const CAPTURED: &str = r#"{"title":"Old","clock":{"dev-A":4}}"#;
    let vault = Vault::new();
    let data = vault.data_conn();
    pending(&data, "note", "n-1", CAPTURED, 400);
    pending(&data, "journal", "j-1", r#"{"date":"2026-01-05"}"#, 410);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = core(&vault);
    assert_eq!(
        outbox(&core),
        owned(&[("journal", "j-1", "delete"), ("note", "n-1", "delete")])
    );
    assert_eq!(
        item(&core, "note", "n-1"),
        (
            CAPTURED.to_owned(),
            Some(r#"{"dev-A":4}"#.to_owned()),
            Some(400_000)
        )
    );
    assert_eq!(
        item(&core, "journal", "j-1").0,
        format!(r#"{{"date":"2026-01-05","clock":{{"{ELECTRON_DEVICE}":1}}}}"#)
    );
    let clocks: i64 = core
        .query_row("SELECT count(*) FROM sync_tombstone_clocks", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(clocks, 0);
}

#[test]
fn a_pending_snapshot_delete_without_an_electron_device_is_refused() {
    let mut vault = Vault::new();
    vault.device_id = None;
    pending(
        &vault.data_conn(),
        "folder_config",
        "Gone",
        r#"{"path":"Gone","clock":{"dev-A":3}}"#,
        300,
    );
    assert_refused(&vault, |e| matches!(e, ImportError::DeleteWithoutDevice));
}

#[test]
fn a_pending_delete_of_a_later_stage_type_is_not_ready() {
    let vault = Vault::new();
    pending(&vault.data_conn(), "task", "t-1", r#"{"id":"t-1"}"#, 300);
    assert_refused(&vault, |e| {
        matches!(e, ImportError::NotReady { area: "tasks or projects", detail }
            if detail.contains("sync_pending_deletes task"))
    });

    let vault = Vault::new();
    pending(&vault.data_conn(), "widget", "w-1", "{}", 300);
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::MalformedRow {
                table: "sync_pending_deletes",
                ..
            }
        )
    });
}

/// `recoverDirtyNotes` and `recoverDirtyJournals`: clocked rows never pushed or modified since,
/// local-only ones aside, go out as recovered updates at their stored clock.
#[test]
fn dirty_notes_are_queued_at_their_stored_clock() {
    let vault = Vault::new();
    seed_note(
        &vault,
        &Note {
            synced_at: Some("2026-01-05T08:30:00.000Z"),
            ..note("dirty")
        },
    );
    seed_note(
        &vault,
        &Note {
            synced_at: None,
            ..note("never")
        },
    );
    seed_note(&vault, &note("clean"));
    seed_note(
        &vault,
        &Note {
            synced_at: None,
            local_only: true,
            ..note("local")
        },
    );
    seed_note(
        &vault,
        &Note {
            journal_date: Some("2026-01-05"),
            synced_at: None,
            ..note("day")
        },
    );

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.queued.get("dirtyRecordsQueued"), Some(&3));
    let core = core(&vault);
    assert_eq!(
        outbox(&core),
        owned(&[
            ("journal", "day", "upsert"),
            ("note", "dirty", "upsert"),
            ("note", "never", "upsert"),
        ])
    );
    assert_eq!(
        item(&core, "note", "dirty").1.as_deref(),
        Some(r#"{"dev-A":5}"#)
    );
}

/// `enqueueCreateOrRecoveredUpdate`: a never-synced template goes out as a create, its
/// `_offline` ticks rebound to the device and then ticked once; one edited since its last sync
/// is a recovered update at its stored clock.
#[test]
fn a_never_synced_template_goes_out_as_a_create_with_a_ticked_clock() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_template(&data, "t-new", Some(r#"{"_offline":2,"dev-A":1}"#), None);
    seed_template(
        &data,
        "t-edit",
        Some(r#"{"dev-A":4}"#),
        Some("2026-01-05T08:30:00.000Z"),
    );
    seed_template(
        &data,
        "t-clean",
        Some(r#"{"dev-A":4}"#),
        Some("2026-01-05T10:00:00.000Z"),
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.queued.get("dirtyRecordsQueued"), Some(&2));
    let core = core(&vault);
    assert_eq!(
        outbox(&core),
        owned(&[
            ("template", "t-edit", "upsert"),
            ("template", "t-new", "create")
        ])
    );
    let minted = r#"{"dev-A":1,"device-electron":3}"#;
    let (payload, clock, _) = item(&core, "template", "t-new");
    assert_eq!(clock.as_deref(), Some(minted));
    assert!(payload.contains(&format!(r#""content":"","clock":{minted},"syncedAt":null"#)));
    let projected: String = core
        .query_row("SELECT clock FROM templates WHERE id = 't-new'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(projected, minted);
    assert_eq!(
        item(&core, "template", "t-edit").1.as_deref(),
        Some(r#"{"dev-A":4}"#)
    );
}

/// The core sync pass's seed over the installed vault, under the core's device id.
fn core_seed(vault: &Vault) -> Vec<(String, String)> {
    let db = open_data(&vault.core().join(DATA_FILE)).unwrap();
    db.call_blocking(|conn| unclocked_seed::seed(conn, CORE_DEVICE, NOW_MS))
        .unwrap()
}

fn owned_ids(rows: &[(&str, &str)]) -> Vec<(String, String)> {
    rows.iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

/// Electron seeds its unclocked rows in its full sync, after the pull, so a version another
/// device pushed first wins. The import stages them with no clock and queues nothing; the core
/// pass's seed (`seedUnclocked`) then mints a re-creatable type's clock past its delete clock
/// (`nextLocalClock`), the others' from nothing (`increment({}, deviceId)`), keeps a `relation`
/// property definition local (`isPersistableDefinitionType`), and runs once.
#[test]
fn an_unclocked_record_is_staged_unclocked_and_seeded_by_the_core_pass() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_unclocked_folder(&data, "Again");
    delete_clock(&data, "folder_config", "Again", r#"{"dev-B":7}"#);
    seed_unclocked_folder(&data, "Fresh");
    seed_tag_category(&data, "cat-u", None);
    seed_property(&data, "rel", "relation");
    seed_property(&data, "sel", "select");
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert!(report.queued.is_empty(), "{:?}", report.queued);
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[]));
    assert_eq!(item(&core, "folder_config", "Again").1, None);
    assert_eq!(item(&core, "tag_category", "cat-u").1, None);

    assert_eq!(
        core_seed(&vault),
        owned_ids(&[
            ("folder_config", "Again"),
            ("folder_config", "Fresh"),
            ("property_definition", "sel"),
            ("tag_category", "cat-u"),
        ])
    );
    assert_eq!(
        outbox(&core),
        owned(&[
            ("folder_config", "Again", "create"),
            ("folder_config", "Fresh", "create"),
            ("property_definition", "sel", "create"),
            ("tag_category", "cat-u", "create"),
        ])
    );
    let past = r#"{"dev-B":7,"device-core":1}"#;
    assert_eq!(
        item(&core, "folder_config", "Again").1.as_deref(),
        Some(past)
    );
    let projected: String = core
        .query_row("SELECT clock FROM folders WHERE path = 'Again'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(projected, past);
    let first = r#"{"device-core":1}"#;
    assert_eq!(
        item(&core, "folder_config", "Fresh").1.as_deref(),
        Some(first)
    );
    assert_eq!(
        item(&core, "tag_category", "cat-u").1.as_deref(),
        Some(first)
    );
    assert_eq!(item(&core, "property_definition", "rel").1, None);
    assert!(core_seed(&vault).is_empty(), "seeded once");
}

/// `seedSkipsDeletedNote`: an unclocked note with a delete clock is a leftover of the delete and
/// the seed holds it back. When this device's pending delete of it is retired because the note
/// is live again, the runtime start re-creates it past the delete
/// (`pushClocklessContentRecreate`), under the Electron device, at import. A local-only note
/// stays local; an unclocked journal day is seeded.
#[test]
fn an_unclocked_deleted_note_is_held_back_unless_its_delete_was_superseded() {
    let vault = Vault::new();
    for id in ["held", "back", "solo", "day"] {
        seed_note(
            &vault,
            &Note {
                clock: None,
                synced_at: None,
                local_only: id == "solo",
                journal_date: (id == "day").then_some("2026-01-05"),
                ..note(id)
            },
        );
    }
    let data = vault.data_conn();
    delete_clock(&data, "note", "held", r#"{"dev-A":3}"#);
    delete_clock(&data, "note", "back", r#"{"dev-A":3}"#);
    pending(&data, "note", "back", r#"{"clock":{"dev-A":3}}"#, 300);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.dropped.get("stalePendingDeletes"), Some(&1));
    assert_eq!(report.queued.get("deletedNotesRecreated"), Some(&1));
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[("note", "back", "create")]));
    assert_eq!(
        item(&core, "note", "back").1.as_deref(),
        Some(r#"{"dev-A":3,"device-electron":1}"#)
    );
    assert_eq!(item(&core, "note", "held").1, None);

    assert_eq!(core_seed(&vault), owned_ids(&[("journal", "day")]));
    assert_eq!(item(&core, "note", "held").1, None);
    assert_eq!(item(&core, "note", "solo").1, None);
}

/// A vault that never signed in (the free plan never syncs) has no device and no clock on any
/// row, or an `_offline` one. Electron's runtime never starts without a session, so nothing is
/// queued and every row keeps what it has, for the core pass to seed once signed in.
#[test]
fn a_never_signed_in_vault_imports_with_nothing_queued() {
    let mut vault = Vault::new();
    vault.device_id = None;
    for id in ["n-1", "n-2"] {
        seed_note(
            &vault,
            &Note {
                clock: None,
                synced_at: None,
                ..note(id)
            },
        );
    }
    let data = vault.data_conn();
    seed_unclocked_folder(&data, "Fresh");
    seed_template(&data, "t-off", Some(r#"{"_offline":2}"#), None);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert!(report.queued.is_empty(), "{:?}", report.queued);
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[]));
    assert_eq!(item(&core, "note", "n-1").1, None);
    assert_eq!(item(&core, "folder_config", "Fresh").1, None);
    assert_eq!(
        item(&core, "template", "t-off").1.as_deref(),
        Some(r#"{"_offline":2}"#)
    );
}

/// REVIEW-5139 finding 2: Electron's `tag_definitions.name` is `NOCASE`, so its
/// `isSupersededByLiveRow` finds live "work" for a pending delete of "Work" and retires the
/// delete. Replayed, the core delete would tombstone "work" in the NOCASE projection, and every
/// peer's NOCASE apply would remove it.
#[test]
fn a_pending_tag_delete_never_removes_a_live_tag_of_another_case() {
    let vault = Vault::new();
    let data = vault.data_conn();
    electron_db::seed(
        &data,
        "tag_definitions",
        &[
            ("name", text("work")),
            ("color", text("teal")),
            ("clock", text(r#"{"dev-A":2}"#)),
            ("created_at", text(CREATED)),
        ],
    );
    pending(
        &data,
        "tag_definition",
        "Work",
        r#"{"name":"Work","color":"rose","clock":{"dev-A":1}}"#,
        300,
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.dropped.get("stalePendingDeletes"), Some(&1));
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[]));
    assert_eq!(item(&core, "tag_definition", "work").2, None);
    let live: i64 = core
        .query_row(
            "SELECT count(*) FROM tag_definitions WHERE name = 'work' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
}

/// REVIEW-5139 M1 (departure 6): a dirty row whose pending delete made it a tombstone is not
/// pushed again; the delete Electron replays after the sweeps wins.
#[test]
fn a_dirty_row_with_a_pending_delete_stays_deleted() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_template(
        &data,
        "t-gone",
        Some(r#"{"dev-A":4}"#),
        Some("2026-01-05T08:30:00.000Z"),
    );
    pending(
        &data,
        "template",
        "t-gone",
        r#"{"id":"t-gone","clock":{"dev-A":4}}"#,
        300,
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.queued.get("dirtyRecordsQueued"), None);
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[("template", "t-gone", "delete")]));
    assert!(item(&core, "template", "t-gone").2.is_some());
}

/// REVIEW-5139 M2: a note created while its push was queued and never synced is both a queued
/// `create` and a dirty row. The outbox keeps the create (`coalesceSyncOperations`), and check 4
/// expects exactly that.
#[test]
fn a_dirty_note_over_its_queued_create_stays_a_create() {
    let vault = Vault::new();
    seed_note(
        &vault,
        &Note {
            synced_at: None,
            ..note("new")
        },
    );
    queue(&vault.data_conn(), "note", "new", "create", "{}", 100);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.queued.get("dirtyRecordsQueued"), Some(&1));
    assert_eq!(outbox(&core(&vault)), owned(&[("note", "new", "create")]));
}
