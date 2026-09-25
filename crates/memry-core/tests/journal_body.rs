//! Journal body writes (spec 005-journal JP020, D2, D5).
//!
//! | Test                                              | Rule                        |
//! | ------------------------------------------------- | --------------------------- |
//! | the first edit creates `j<date>` in one commit     | D2, FR-030                  |
//! | a tombstoned day revives under its own id          | D5, `date` UNIQUE           |
//! | a day desktop created is edited under its id       | D5, §7.1                    |
//! | a failing edit creates nothing                     | D2                          |
//! | a no-op edit writes and creates nothing            | no-op writes push nothing   |
//! | an entry edit needs a live journal id              | JP003d liveness             |

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, extract_text, update_log};
use memry_core::domain::journal;
use memry_core::domain::journal_ops::body::{self, EditDayOutcome};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::json;
use yrs::{
    Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim,
};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DAY: &str = "2026-04-16";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-body-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("count")
}

/// Every outbox row as `(item_type, item_id, op)`, oldest first.
fn outbox(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// The body text of `doc_id`, rebuilt from the durable log as the read surface
/// rebuilds it.
fn text_of(conn: &Connection, doc_id: &str) -> String {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("reader", sink)
        .get_or_open(doc_id)
        .expect("open");
    for blob in update_log::load_plan(conn, doc_id).expect("plan").blobs() {
        document.apply_durable_update(blob).expect("apply");
    }
    extract_text(&document).expect("text")
}

fn remote_day(item_id: &str, date: &str) -> sync_items::InboundRecord {
    sync_items::InboundRecord {
        item_type: "journal".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: json!({"date": date, "clock": {"device-b": 4}}).to_string(),
        server_cursor: Some(9),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// A body holding one paragraph, authored elsewhere, as a server update.
fn one_paragraph(block_id: &str, text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", block_id);
    let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
    paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Moves a block after itself, which authors nothing.
fn stay_put(block_id: &str) -> BlockEdit {
    BlockEdit::MoveBlock {
        block_id: block_id.to_owned(),
        after_block_id: Some(block_id.to_owned()),
    }
}

fn append(text: &str, block_id: &str) -> BlockEdit {
    BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_owned(),
        new_block_id: block_id.to_owned(),
    }
}

fn set_text(block_id: &str, text: &str) -> BlockEdit {
    BlockEdit::SetText {
        block_id: block_id.to_owned(),
        text: text.to_owned(),
    }
}

#[test]
fn the_first_edit_creates_the_day_and_its_update_in_one_commit() {
    let db = open("create");
    db.call_blocking(|conn| {
        assert_eq!(journal::entry_for(conn, DAY)?, None);

        let outcome = body::edit_day(conn, DAY, &append("Morning pages", "b1"), DEVICE, NOW)
            .expect("the edit");
        assert_eq!(
            outcome,
            EditDayOutcome {
                id: "j2026-04-16".to_owned(),
                created: true,
                revived: false,
                changed: true,
            }
        );
        assert_eq!(
            journal::live_entry(conn, DAY)?,
            Some("j2026-04-16".to_owned())
        );
        assert_eq!(
            outbox(conn),
            vec![
                ("journal".into(), "j2026-04-16".into(), "upsert".into()),
                ("journal".into(), "j2026-04-16".into(), "crdt-update".into()),
            ],
            "exactly one record upsert and one body update"
        );
        assert_eq!(text_of(conn, "j2026-04-16"), "Morning pages");

        // A second edit on the now-live day writes only the body update.
        let second = body::edit_day(conn, DAY, &set_text("b1", "Evening pages"), DEVICE, NOW + 1)
            .expect("the second edit");
        assert!(!second.created && !second.revived && second.changed);
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'upsert'"),
            1
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'crdt-update'"),
            2
        );
        assert_eq!(text_of(conn, "j2026-04-16"), "Evening pages");
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_tombstoned_day_revives_under_its_own_id() {
    let db = open("revive");
    db.call_blocking(|conn| {
        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;
        let mut tombstone = remote_day("legacy-journal-id", DAY);
        tombstone.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &tombstone, NOW + 1)?;

        let outcome = body::edit_day(conn, DAY, &append("Back again", "b1"), DEVICE, NOW + 2)
            .expect("the edit");
        assert_eq!(outcome.id, "legacy-journal-id");
        assert!(outcome.revived && !outcome.created && outcome.changed);
        assert_eq!(
            journal::live_entry(conn, DAY)?,
            Some("legacy-journal-id".to_owned())
        );
        assert!(sync_items::load(conn, "journal", "j2026-04-16")?.is_none());
        assert_eq!(text_of(conn, "legacy-journal-id"), "Back again");
        Ok(())
    })
    .expect("revive");
}

#[test]
fn a_day_desktop_created_is_edited_under_its_own_id() {
    let db = open("remote");
    db.call_blocking(|conn| {
        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;
        update_log::append_server_update(
            conn,
            "legacy-journal-id",
            1,
            &one_paragraph("desk-1", "From desktop"),
            NOW,
        )
        .expect("the server update");

        let outcome = body::edit_day(conn, DAY, &append("From the phone", "b2"), DEVICE, NOW + 1)
            .expect("the edit");
        assert_eq!(
            outcome,
            EditDayOutcome {
                id: "legacy-journal-id".to_owned(),
                created: false,
                revived: false,
                changed: true,
            }
        );
        assert_eq!(
            outbox(conn),
            vec![(
                "journal".into(),
                "legacy-journal-id".into(),
                "crdt-update".into()
            )]
        );
        assert!(sync_items::load(conn, "journal", "j2026-04-16")?.is_none());
        assert_eq!(
            text_of(conn, "legacy-journal-id"),
            "From desktop\nFrom the phone"
        );
        Ok(())
    })
    .expect("remote");
}

#[test]
fn a_failing_edit_creates_nothing() {
    let db = open("fail");
    db.call_blocking(|conn| {
        assert!(body::edit_day(conn, DAY, &set_text("missing", "x"), DEVICE, NOW).is_err());
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM sync_items"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), 0);

        // A tombstoned day stays tombstoned.
        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;
        let mut tombstone = remote_day("legacy-journal-id", DAY);
        tombstone.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &tombstone, NOW + 1)?;
        assert!(body::edit_day(conn, DAY, &set_text("missing", "x"), DEVICE, NOW + 2).is_err());
        assert_eq!(
            journal::entry_for(conn, DAY)?,
            Some(("legacy-journal-id".to_owned(), true))
        );
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);

        // An invalid date is refused before anything is read or written.
        assert!(body::edit_day(conn, "2026-02-30", &append("x", "b1"), DEVICE, NOW).is_err());
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);
        Ok(())
    })
    .expect("fail");
}

#[test]
fn a_no_op_edit_writes_nothing_and_creates_nothing() {
    let db = open("noop");
    db.call_blocking(|conn| {
        // A body pulled before its record: the day has no entry yet.
        update_log::append_server_update(conn, "j2026-04-16", 1, &one_paragraph("b1", "Same"), NOW)
            .expect("the server update");
        let unchanged = body::edit_day(conn, DAY, &stay_put("b1"), DEVICE, NOW).expect("the no-op");
        assert_eq!(
            unchanged,
            EditDayOutcome {
                id: "j2026-04-16".to_owned(),
                created: false,
                revived: false,
                changed: false,
            }
        );
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), 1);

        // On a live day too.
        body::edit_day(conn, DAY, &set_text("b1", "Changed"), DEVICE, NOW + 1).expect("edit");
        let queued = count(conn, "SELECT count(*) FROM outbox");
        let updates = count(conn, "SELECT count(*) FROM yjs_updates");
        let again = body::edit_day(conn, DAY, &stay_put("b1"), DEVICE, NOW + 2).expect("the no-op");
        assert!(!again.changed && !again.created);
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), queued);
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), updates);
        Ok(())
    })
    .expect("noop");
}

#[test]
fn an_entry_edit_needs_a_live_journal_id() {
    let db = open("entry");
    db.call_blocking(|conn| {
        assert!(
            !body::edit_entry(conn, "j2026-04-16", &append("x", "b1"), DEVICE, NOW)
                .expect("the refusal")
        );
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);

        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;
        assert!(
            body::edit_entry(
                conn,
                "legacy-journal-id",
                &append("Entry text", "b1"),
                DEVICE,
                NOW + 1
            )
            .expect("the edit")
        );
        assert_eq!(
            outbox(conn),
            vec![(
                "journal".into(),
                "legacy-journal-id".into(),
                "crdt-update".into()
            )]
        );
        assert_eq!(text_of(conn, "legacy-journal-id"), "Entry text");

        let mut tombstone = remote_day("legacy-journal-id", DAY);
        tombstone.deleted_at = Some(NOW + 2);
        sync_items::apply_remote(conn, &tombstone, NOW + 2)?;
        assert!(
            !body::edit_entry(
                conn,
                "legacy-journal-id",
                &append("Gone", "b2"),
                DEVICE,
                NOW + 3
            )
            .expect("the refusal")
        );
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 1);
        Ok(())
    })
    .expect("entry");
}
