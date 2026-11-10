//! An Inbox capture's file between devices (#4157, §14.7.2) against real
//! SQLite: the payload's `attachmentId` through the apply path every pull
//! uses, and the bookkeeping the upload pass reads.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | a payload with an attachment id projects it               | §13.7.15, `inbox_view`                |
//! | an older payload without the key keeps the local id       | §13.7.15, absent keeps                |
//! | an explicit null keeps the local id                       | §13.7.15, `attachmentId` is sticky    |
//! | a file capture is marked pending in its own write         | §14.7.2, upload on capture            |
//! | recording the id is a local edit that pushes it           | §14.7.2, clock bump and outbox        |
//! | deleting an unfiled upload records a release              | §14.7.2, 30-day grace                 |
//! | filing leaves no upload pending and no release            | §14.7.2, the note owns the bytes      |
//! | a release is due after thirty days and not before         | §14.8                                 |
//! | a note's reference keeps a file out of the release        | §14.7.2, filing reuse                 |
//! | the pass only follows the capture's own folder            | §14.7.2, receiver path rule           |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::inbox::attachments::{
    self as files, RELEASE_GRACE_MS, UploadPlan, download_target, plan_upload,
};
use memry_core::domain::inbox::write::{self, NewCapture};
use memry_core::domain::inbox::{self};
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_790_251_200_000;
const DEVICE: &str = "phone";
const PATH: &str = "attachments/inbox/inbox-1/photo.png";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-inbox-attachments-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn payload(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "inbox", id)
        .expect("row")
        .expect("payload");
    serde_json::from_str(&raw).expect("json")
}

fn peer(clock: u64, extra: Value) -> Value {
    let mut base = json!({
        "type": "image",
        "title": "photo",
        "attachmentPath": PATH,
        "clock": { "desktop": clock },
    });
    for (key, value) in extra.as_object().expect("object") {
        base[key] = value.clone();
    }
    base
}

fn apply(conn: &Connection, payload: &Value) {
    let record = InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: "inbox-1".to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("desktop".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    apply_inbound(conn, &record, NOW).expect("apply");
}

fn file_capture(conn: &Connection, id: &str) {
    write::capture(
        conn,
        &NewCapture {
            id: Some(id.to_owned()),
            item_type: "image".to_owned(),
            title: "photo".to_owned(),
            processing_status: "complete".to_owned(),
            attachment_path: Some(format!("attachments/inbox/{id}/photo.png")),
            ..NewCapture::default()
        },
        DEVICE,
        NOW,
    )
    .expect("capture")
    .acknowledge();
}

fn outbox_len(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("count")
}

fn release_ids(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT item_id, attachment_id FROM inbox_attachment_releases ORDER BY item_id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn a_payload_with_an_attachment_id_projects_it() {
    let db = open("project");
    db.call_blocking(|conn| {
        apply(conn, &peer(1, json!({ "attachmentId": "att-1" })));
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(item.attachment_id.as_deref(), Some("att-1"));
        assert_eq!(payload(conn, "inbox-1")["attachmentId"], "att-1");
        Ok(())
    })
    .expect("ok");
}

#[test]
fn an_older_payload_without_the_key_keeps_the_local_id() {
    let db = open("older");
    db.call_blocking(|conn| {
        apply(conn, &peer(1, json!({ "attachmentId": "att-1" })));
        apply(conn, &peer(2, json!({ "title": "renamed" })));
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(item.title, "renamed");
        assert_eq!(item.attachment_id.as_deref(), Some("att-1"));
        assert_eq!(payload(conn, "inbox-1")["attachmentId"], "att-1");
        Ok(())
    })
    .expect("ok");
}

#[test]
fn an_explicit_null_keeps_the_local_id() {
    let db = open("null");
    db.call_blocking(|conn| {
        apply(conn, &peer(1, json!({ "attachmentId": "att-1" })));
        apply(
            conn,
            &peer(2, json!({ "attachmentId": null, "title": "renamed" })),
        );
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(item.title, "renamed");
        assert_eq!(item.attachment_id.as_deref(), Some("att-1"));
        assert_eq!(payload(conn, "inbox-1")["attachmentId"], "att-1");

        apply(conn, &peer(3, json!({ "attachmentId": "att-2" })));
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(item.attachment_id.as_deref(), Some("att-2"));
        Ok(())
    })
    .expect("ok");
}

#[test]
fn a_file_capture_is_marked_pending_in_its_own_write() {
    let db = open("pending");
    db.call_blocking(|conn| {
        file_capture(conn, "inbox-1");
        write::capture_text(
            conn,
            "a thought worth keeping around",
            None,
            None,
            true,
            DEVICE,
            NOW,
        )?;
        assert_eq!(files::pending_ids(conn)?, vec!["inbox-1".to_owned()]);

        // A payload with no attachment id: nothing uploaded yet.
        assert_eq!(payload(conn, "inbox-1").get("attachmentId"), None);
        let item = inbox::get(conn, "inbox-1")?.expect("capture");
        assert_eq!(item.attachment_id, None);
        Ok(())
    })
    .expect("ok");
}

#[test]
fn recording_the_id_is_a_local_edit_that_pushes_it() {
    let db = open("record");
    db.call_blocking(|conn| {
        file_capture(conn, "inbox-1");
        conn.execute("DELETE FROM outbox", []).expect("drain");
        let clock_before = payload(conn, "inbox-1")["clock"].clone();

        files::set_attachment_id(conn, "inbox-1", "att-1", DEVICE, NOW + 1)?;
        files::clear_pending(conn, "inbox-1")?;

        let pushed = payload(conn, "inbox-1");
        assert_eq!(pushed["attachmentId"], "att-1");
        assert_ne!(pushed["clock"], clock_before, "the document clock ticked");
        assert_eq!(outbox_len(conn), 1, "the capture is queued to push");
        assert_eq!(
            inbox::get(conn, "inbox-1")?
                .expect("live")
                .attachment_id
                .as_deref(),
            Some("att-1")
        );
        assert!(files::pending_ids(conn)?.is_empty());
        Ok(())
    })
    .expect("ok");
}

#[test]
fn deleting_an_unfiled_upload_records_a_release_and_clears_the_mark() {
    let db = open("delete");
    db.call_blocking(|conn| {
        file_capture(conn, "inbox-1");
        files::set_attachment_id(conn, "inbox-1", "att-1", DEVICE, NOW + 1)?;
        file_capture(conn, "inbox-2");
        write::delete_permanent(conn, "inbox-1", DEVICE, NOW + 2)?.acknowledge();
        write::delete_permanent(conn, "inbox-2", DEVICE, NOW + 2)?.acknowledge();

        assert_eq!(
            release_ids(conn),
            vec![("inbox-1".to_owned(), "att-1".to_owned())],
            "only the capture that was uploaded"
        );
        assert!(files::pending_ids(conn)?.is_empty());
        Ok(())
    })
    .expect("ok");
}

#[test]
fn filing_leaves_no_upload_pending_and_no_release() {
    let db = open("file");
    db.call_blocking(|conn| {
        file_capture(conn, "inbox-1");
        file_capture(conn, "inbox-2");
        files::set_attachment_id(conn, "inbox-2", "att-2", DEVICE, NOW + 1)?;
        write::mark_filed(conn, "inbox-1", "Notes/photo.md", "note", DEVICE, NOW + 2)?
            .acknowledge();
        write::mark_filed(conn, "inbox-2", "Notes/two.md", "note", DEVICE, NOW + 2)?.acknowledge();
        // A capture filed on this device after it was uploaded keeps the note's
        // reuse of its bytes; deleting the filed row does not free them.
        write::delete_permanent(conn, "inbox-2", DEVICE, NOW + 3)?.acknowledge();

        assert!(release_ids(conn).is_empty());
        assert!(files::pending_ids(conn)?.is_empty());
        Ok(())
    })
    .expect("ok");
}

#[test]
fn a_release_is_due_after_thirty_days_and_not_before() {
    let db = open("due");
    db.call_blocking(|conn| {
        file_capture(conn, "inbox-1");
        files::set_attachment_id(conn, "inbox-1", "att-1", DEVICE, NOW + 1)?;
        write::delete_permanent(conn, "inbox-1", DEVICE, NOW)?.acknowledge();

        assert!(files::due_releases(conn, NOW + RELEASE_GRACE_MS - 1)?.is_empty());
        let due = files::due_releases(conn, NOW + RELEASE_GRACE_MS)?;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].attachment_id, "att-1");

        files::drop_release(conn, "inbox-1")?;
        assert!(files::due_releases(conn, NOW + RELEASE_GRACE_MS)?.is_empty());
        Ok(())
    })
    .expect("ok");
}

#[test]
fn a_notes_reference_keeps_a_file_out_of_the_release() {
    let db = open("referenced");
    db.call_blocking(|conn| {
        assert!(!files::referenced_by_live_note(conn, "att-1")?);
        notes::create(
            conn,
            &NewNote {
                id: "note-1",
                title: "Filed",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        notes::add_attachment_reference(conn, "note-1", "att-1", DEVICE, NOW + 1)?;
        assert!(files::referenced_by_live_note(conn, "att-1")?);
        assert!(!files::referenced_by_live_note(conn, "att-2")?);
        Ok(())
    })
    .expect("ok");
}

#[test]
fn the_pass_only_follows_the_captures_own_folder() {
    let db = open("paths");
    db.call_blocking(|conn| {
        apply(conn, &peer(1, json!({ "attachmentId": "att-1" })));
        let good = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(download_target(&good), Some(("att-1", PATH)));

        for (step, bad) in [
            "attachments/inbox/other/photo.png",
            "attachments/inbox/inbox-1/../../../evil",
            "attachments/inbox/inbox-1/a/b.png",
            "attachments/inbox/inbox-1/a\\b.png",
            "attachments/photo.png",
            "../attachments/inbox/inbox-1/photo.png",
        ]
        .into_iter()
        .enumerate()
        {
            apply(
                conn,
                &peer(
                    10 + step as u64,
                    json!({ "attachmentId": "att-1", "attachmentPath": bad }),
                ),
            );
            let item = inbox::get(conn, "inbox-1")?.expect("projected");
            assert_eq!(download_target(&item), None, "{bad} is not downloaded");
        }

        // A pending capture with such a path is dropped, not uploaded.
        apply(
            conn,
            &peer(
                20,
                json!({ "attachmentPath": "attachments/inbox/other/x.png" }),
            ),
        );
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(plan_upload(Some(&item)), UploadPlan::Drop);
        Ok(())
    })
    .expect("ok");
}

#[test]
fn which_captures_upload_and_which_download_is_decided_from_the_row() {
    let db = open("decisions");
    db.call_blocking(|conn| {
        apply(conn, &peer(1, json!({ "metadata": { "mimeType": "image/png" } })));
        let fresh = inbox::get(conn, "inbox-1")?.expect("projected");
        let UploadPlan::Upload(target) = plan_upload(Some(&fresh)) else {
            panic!("an unfiled capture with a valid path and no id uploads");
        };
        assert_eq!(
            (target.filename.as_str(), target.mime_type.as_str(), target.path.as_str()),
            ("photo.png", "image/png", PATH)
        );
        assert_eq!(download_target(&fresh), None, "no id, nothing to download");
        assert_eq!(plan_upload(None), UploadPlan::Drop);

        apply(conn, &peer(2, json!({ "attachmentId": "att-1" })));
        let uploaded = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(plan_upload(Some(&uploaded)), UploadPlan::Drop, "already uploaded");
        assert!(download_target(&uploaded).is_some());

        apply(
            conn,
            &peer(3, json!({ "filedAt": "2026-10-01T09:00:00.000Z", "filedTo": "n.md", "filedAction": "note" })),
        );
        let filed = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(plan_upload(Some(&filed)), UploadPlan::Drop);
        assert_eq!(download_target(&filed), None, "a filed capture's bytes belong to its note");
        Ok(())
    })
    .expect("ok");
}
