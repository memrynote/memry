//! Inbox writes (spec 006 IB020-IB028) against real SQLite.
//!
//! | Test                                                   | Desktop reference                   |
//! | ------------------------------------------------------ | ----------------------------------- |
//! | a text capture writes desktop's full row and queues it | `captureTextItem`, full-row push    |
//! | a duplicate text or link comes back unless forced      | `findDuplicateBy*`, `force`         |
//! | a link capture awaits enrichment; x.com is social      | `captureLink`, `storeSocialMetadata`|
//! | snooze, unsnooze, archive, unarchive push explicit null| `snooze.ts`, `crud.ts`              |
//! | a delete tombstones and queues a delete                | `handleDeletePermanent`             |
//! | filing to a folder makes a bodied note and files it    | `fileToFolder`, `markItemAsFiled`   |
//! | convert to task and to reminder                        | `convertToTask`, `convertToReminder`|
//! | linking appends under Inbox Captures                   | `linkToNotes`                       |
//! | bulk counts partial failures                           | `BulkResponse`                      |
//! | the lifecycle payloads match the committed fixture     | IB028, desktop handler test         |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::inbox::convert::{self, LinkTarget, TaskInput};
use memry_core::domain::inbox::filing::{self, LocalStamp};
use memry_core::domain::inbox::write::{self, Captured, NewCapture};
use memry_core::domain::inbox::{self};
use memry_core::domain::{reads, reminders};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_790_251_200_000;
const DEVICE: &str = "phone";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-inbox-write-{label}-{}-{unique}",
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

fn now() -> LocalStamp {
    LocalStamp::parse("2026-09-24T14:05").expect("stamp")
}

fn created(captured: Captured) -> inbox::InboxItem {
    match captured {
        Captured::Created(item) => item,
        Captured::Duplicate(item) => panic!("unexpected duplicate of {}", item.id),
    }
}

/// The thirteen schema keys plus desktop's local columns: what desktop's own
/// push of a new row carries.
const ROW_KEYS: [&str; 25] = [
    "id",
    "type",
    "title",
    "content",
    "createdAt",
    "modifiedAt",
    "filedAt",
    "filedTo",
    "filedAction",
    "snoozedUntil",
    "snoozeReason",
    "viewedAt",
    "processingStatus",
    "processingError",
    "metadata",
    "attachmentPath",
    "thumbnailPath",
    "transcription",
    "transcriptionStatus",
    "sourceUrl",
    "sourceTitle",
    "captureSource",
    "archivedAt",
    "clock",
    "localOnly",
];

#[test]
fn a_text_capture_writes_desktops_full_row_and_queues_it() {
    let db = open("text");
    db.call_blocking(|conn| {
        let item = created(write::capture_text(
            conn,
            "[agent] a thought worth keeping around",
            None,
            Some("inline"),
            false,
            DEVICE,
            NOW,
        )?);
        assert_eq!(item.item_type, "note");
        assert_eq!(item.title, "[agent] a thought worth keeping around");
        let p = payload(conn, &item.id);
        let keys: Vec<&str> = p
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        for key in ROW_KEYS {
            assert!(keys.contains(&key), "missing {key}");
        }
        assert_eq!(p["filedAt"], Value::Null);
        assert_eq!(p["captureSource"], "inline");
        assert_eq!(p["clock"], json!({ "phone": 1 }));
        assert_eq!(
            outbox(conn),
            [("inbox".to_owned(), item.id.clone(), "upsert".to_owned())]
        );
        let long = "x".repeat(60);
        let titled = created(write::capture_text(
            conn, &long, None, None, false, DEVICE, NOW,
        )?);
        assert_eq!(titled.title, format!("{}...", "x".repeat(50)));
        Ok(())
    })
    .expect("text");
}

#[test]
fn a_duplicate_text_or_link_comes_back_unless_forced() {
    let db = open("dup");
    db.call_blocking(|conn| {
        let text = "[agent] Pick up the cable before Friday";
        let first = created(write::capture_text(
            conn, text, None, None, false, DEVICE, NOW,
        )?);
        match write::capture_text(conn, text, None, None, false, DEVICE, NOW)? {
            Captured::Duplicate(item) => assert_eq!(item.id, first.id),
            Captured::Created(_) => panic!("expected a duplicate"),
        }
        created(write::capture_text(
            conn, text, None, None, true, DEVICE, NOW,
        )?);
        let url = "https://example.com/agent/1";
        let link = created(write::capture_link(conn, url, None, false, DEVICE, NOW)?);
        assert!(matches!(
            write::capture_link(conn, url, None, false, DEVICE, NOW)?,
            Captured::Duplicate(_)
        ));
        write::archive(conn, &link.id, DEVICE, NOW)?.acknowledge();
        // An archived capture is no longer a duplicate.
        created(write::capture_link(conn, url, None, false, DEVICE, NOW)?);
        Ok(())
    })
    .expect("dup");
}

#[test]
fn a_link_capture_awaits_enrichment_and_x_is_social() {
    let db = open("link");
    db.call_blocking(|conn| {
        let link = created(write::capture_link(
            conn,
            "https://example.com/agent/how-we-build",
            None,
            false,
            DEVICE,
            NOW,
        )?);
        assert_eq!(
            (link.item_type.as_str(), link.title.as_str()),
            ("link", "How We Build")
        );
        assert_eq!(link.processing_status.as_deref(), Some("pending"));
        assert_eq!(link.metadata_text("fetchStatus"), Some("pending"));
        assert_eq!(inbox::fetching_count(conn)?, 1);
        let done = write::complete_link(
            conn,
            &link.id,
            Some("How Linear builds product"),
            Some("Small teams."),
            json!({ "siteName": "Linear", "fetchStatus": "complete" })
                .as_object()
                .expect("obj"),
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert_eq!(done.title, "How Linear builds product");
        assert_eq!(done.content.as_deref(), Some("Small teams."));
        assert_eq!(
            done.metadata_text("url"),
            Some("https://example.com/agent/how-we-build")
        );
        assert_eq!(done.processing_status.as_deref(), Some("complete"));
        let social = created(write::capture_link(
            conn,
            "https://x.com/karpathy/status/123",
            None,
            false,
            DEVICE,
            NOW,
        )?);
        assert_eq!(
            (social.item_type.as_str(), social.title.as_str()),
            ("social", "Tweet by @karpathy")
        );
        assert_eq!(social.metadata_text("tweetId"), Some("123"));
        Ok(())
    })
    .expect("link");
}

#[test]
fn snooze_unsnooze_archive_unarchive_push_explicit_nulls() {
    let db = open("states");
    db.call_blocking(|conn| {
        let item = created(write::capture_text(
            conn,
            "[agent] states",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        assert!(write::snooze(conn, &item.id, NOW - 1, None, DEVICE, NOW).is_err());
        write::snooze(conn, &item.id, NOW + 3_600_000, Some("later"), DEVICE, NOW)?.acknowledge();
        assert!(inbox::list_active(conn, false)?.is_empty());
        write::unsnooze(conn, &item.id, DEVICE, NOW)?.acknowledge();
        let p = payload(conn, &item.id);
        assert_eq!(
            (p["snoozedUntil"].clone(), p["snoozeReason"].clone()),
            (Value::Null, Value::Null)
        );
        assert_eq!(p["clock"], json!({ "phone": 3 }));
        write::archive(conn, &item.id, DEVICE, NOW)?.acknowledge();
        assert_eq!(inbox::archived(conn, None, 10, 0)?.len(), 1);
        write::unarchive(conn, &item.id, DEVICE, NOW)?.acknowledge();
        assert_eq!(payload(conn, &item.id)["archivedAt"], Value::Null);
        write::mark_viewed(conn, &item.id, DEVICE, NOW)?.acknowledge();
        assert!(
            inbox::get(conn, &item.id)?
                .expect("live")
                .viewed_at
                .is_some()
        );
        // Due snoozes come back.
        write::snooze(conn, &item.id, NOW + 1_000, None, DEVICE, NOW)?.acknowledge();
        let back = write::resurface_due(conn, DEVICE, NOW + 2_000)?;
        assert_eq!(back.len(), 1);
        assert_eq!(inbox::list_active(conn, false)?.len(), 1);
        Ok(())
    })
    .expect("states");
}

#[test]
fn a_delete_tombstones_and_queues_a_delete() {
    let db = open("delete");
    db.call_blocking(|conn| {
        let item = created(write::capture_text(
            conn,
            "[agent] gone soon",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        write::add_tag(conn, &item.id, "agent", NOW)?;
        assert_eq!(inbox::get(conn, &item.id)?.expect("live").tags, ["agent"]);
        write::delete_permanent(conn, &item.id, DEVICE, NOW)?.acknowledge();
        assert!(inbox::get(conn, &item.id)?.is_none());
        assert_eq!(outbox(conn).last().map(|r| r.2.as_str()), Some("delete"));
        Ok(())
    })
    .expect("delete");
}

#[test]
fn filing_to_a_folder_makes_a_bodied_note_and_files_the_capture() {
    let db = open("file");
    db.call_blocking(|conn| {
        let item = created(write::capture_text(
            conn,
            "[agent] a filed thought\n\nSecond paragraph.",
            Some("[agent] a filed thought"),
            None,
            false,
            DEVICE,
            NOW,
        )?);
        write::snooze(conn, &item.id, NOW + 3_600_000, None, DEVICE, NOW)?.acknowledge();
        write::add_tag(conn, &item.id, "agent", NOW)?;
        let (note_id, path) = filing::file_text(
            conn,
            &item.id,
            Some("Agent Test/Reading"),
            &[],
            "folder",
            &now(),
            DEVICE,
            NOW,
        )?;
        assert_eq!(path, "Agent Test/Reading/[agent] a filed thought.md");
        let filed = inbox::get(conn, &item.id)?.expect("live");
        assert_eq!(filed.filed_action.as_deref(), Some("folder"));
        assert_eq!(filed.filed_to.as_deref(), Some(path.as_str()));
        assert!(filed.snoozed_until.is_none(), "filing clears the snooze");
        let blocks = reads::note_blocks(conn, &note_id)
            .expect("blocks")
            .expect("note");
        let texts: Vec<String> = blocks
            .iter()
            .map(|b| b.inline.iter().map(|r| r.text.clone()).collect())
            .collect();
        assert_eq!(texts[0], "[agent] a filed thought");
        assert_eq!(texts[1], "Second paragraph.");
        assert_eq!(blocks[2].kind, "divider");
        assert_eq!(texts[3], "Filed from Inbox on Sep 24, 2026");
        let tags: Vec<String> = conn
            .prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")
            .and_then(|mut s| s.query_map([&note_id], |r| r.get(0))?.collect())
            .expect("tags");
        assert_eq!(tags, ["agent", "inbox"]);
        let folders: i64 = conn
            .query_row(
                "SELECT count(*) FROM folders WHERE path IN ('Agent Test', 'Agent Test/Reading')",
                [],
                |r| r.get(0),
            )
            .expect("folders");
        assert_eq!(folders, 2);
        assert!(
            filing::file_text(conn, &item.id, None, &[], "folder", &now(), DEVICE, NOW).is_err()
        );
        write::undo_file(conn, &item.id, DEVICE, NOW)?.acknowledge();
        assert_eq!(payload(conn, &item.id)["filedAction"], Value::Null);
        Ok(())
    })
    .expect("file");
}

#[test]
fn a_link_files_as_a_link_mention_and_the_description() {
    let db = open("file-link");
    db.call_blocking(|conn| {
        let link = created(write::capture_link(
            conn,
            "https://example.com/agent/2",
            None,
            false,
            DEVICE,
            NOW,
        )?);
        write::complete_link(
            conn,
            &link.id,
            Some("Agent Test link"),
            Some("A description."),
            json!({ "author": "Kaan", "fetchStatus": "complete" })
                .as_object()
                .expect("o"),
            DEVICE,
            NOW,
        )?
        .acknowledge();
        let (note_id, _) =
            filing::file_text(conn, &link.id, None, &[], "folder", &now(), DEVICE, NOW)?;
        let blocks = reads::note_blocks(conn, &note_id)
            .expect("blocks")
            .expect("note");
        assert!(
            blocks[0]
                .inline
                .iter()
                .any(|r| r.marks.iter().any(|m| m == "linkMention"))
        );
        assert_eq!(blocks[1].kind, "quote");
        let author: String = blocks[2].inline.iter().map(|r| r.text.clone()).collect();
        assert_eq!(author, "Author: Kaan");
        Ok(())
    })
    .expect("file link");
}

#[test]
fn convert_to_task_and_to_reminder() {
    let db = open("convert");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO projects (id, name, color, position, is_inbox) VALUES ('inbox', 'Inbox', '#000', 0, 1)",
            [],
        )
        .expect("inbox project");
        let item = created(write::capture_text(conn, "[agent] call the bank", None, None, false, DEVICE, NOW)?);
        let task_id = convert::convert_to_task(
            conn, &item.id, &TaskInput { priority: 3, due_date: Some("2026-09-25".into()), ..TaskInput::default() },
            &now(), DEVICE, NOW,
        )?;
        let filed = inbox::get(conn, &item.id)?.expect("live");
        assert_eq!((filed.filed_action.as_deref(), filed.filed_to.as_deref()), (Some("task"), Some(task_id.as_str())));
        let (title, priority, project): (String, i64, String) = conn
            .query_row("SELECT title, priority, project_id FROM tasks WHERE id = ?1", [&task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("task");
        assert_eq!((title.as_str(), priority, project.as_str()), ("[agent] call the bank", 3, "inbox"));

        let voice = write::capture(
            conn,
            &NewCapture { item_type: "image".into(), title: "photo".into(), processing_status: "complete".into(), ..NewCapture::default() },
            DEVICE, NOW,
        )?
        .acknowledge();
        assert!(convert::convert_to_reminder(conn, &voice.id, "2026-09-25T09:00:00.000Z", NOW + 1, &now(), DEVICE, NOW).is_err());
        let text = created(write::capture_text(conn, "[agent] remind me", None, None, false, DEVICE, NOW)?);
        assert!(convert::convert_to_reminder(conn, &text.id, "2026-09-24T09:00:00.000Z", NOW - 1, &now(), DEVICE, NOW).is_err());
        let note_id = convert::convert_to_reminder(conn, &text.id, "2026-09-25T09:00:00.000Z", NOW + 86_400_000, &now(), DEVICE, NOW)?;
        let due = reminders::due_window(conn, None)?;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].reminder.target_id, note_id);
        assert_eq!(inbox::get(conn, &text.id)?.expect("live").filed_action.as_deref(), Some("reminder"));
        Ok(())
    })
    .expect("convert");
}

#[test]
fn linking_appends_under_inbox_captures() {
    let db = open("link-notes");
    db.call_blocking(|conn| {
        let item = created(write::capture_text(
            conn,
            "[agent] link me somewhere",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        let ids = convert::link_to_notes(
            conn,
            &item.id,
            &[LinkTarget::New("Agent Test target".into())],
            &[],
            None,
            &now(),
            DEVICE,
            NOW,
        )?;
        let blocks = reads::note_blocks(conn, &ids[0])
            .expect("blocks")
            .expect("note");
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[1].kind, "bulletListItem");
        assert!(
            blocks[1]
                .inline
                .iter()
                .any(|r| r.marks.iter().any(|m| m == "wikiLink"))
        );
        let filed = inbox::get(conn, &item.id)?.expect("live");
        assert_eq!(filed.filed_action.as_deref(), Some("linked"));
        assert_eq!(filed.filed_to.as_deref(), Some("Agent Test target.md"));
        // A second capture lands under the same heading.
        let second = created(write::capture_text(
            conn,
            "[agent] another one here",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        convert::link_to_notes(
            conn,
            &second.id,
            &[LinkTarget::Note(ids[0].clone())],
            &[],
            None,
            &now(),
            DEVICE,
            NOW,
        )?;
        let blocks = reads::note_blocks(conn, &ids[0])
            .expect("blocks")
            .expect("note");
        assert_eq!(blocks.iter().filter(|b| b.kind == "heading").count(), 1);
        assert_eq!(blocks.len(), 3);
        Ok(())
    })
    .expect("link");
}

#[test]
fn bulk_counts_partial_failures() {
    let db = open("bulk");
    db.call_blocking(|conn| {
        let a = created(write::capture_text(
            conn,
            "[agent] bulk one is here",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        let b = created(write::capture_text(
            conn,
            "[agent] bulk two is here",
            None,
            None,
            false,
            DEVICE,
            NOW,
        )?);
        let ids = vec![a.id.clone(), b.id.clone(), "missing".to_owned()];
        let out = convert::bulk_snooze(conn, &ids, NOW + 60_000, None, DEVICE, NOW);
        assert_eq!(out.processed, 2);
        assert_eq!(out.errors.len(), 1);
        let out = convert::bulk_archive(conn, &ids, DEVICE, NOW);
        assert_eq!((out.processed, out.errors.len()), (2, 1));
        let out = convert::bulk_tag(conn, &ids, &["agent".to_owned()], NOW);
        assert_eq!((out.processed, out.errors.len()), (2, 1));
        Ok(())
    })
    .expect("bulk");
}

/// IB028: the payloads one capture's lifecycle pushes, pinned in
/// `packages/contracts/test-vectors/inbox-ios-payloads.json`, which desktop's
/// `inbox-handler-ios.test.ts` parses and applies. `MEMRY_UPDATE_FIXTURES=1`
/// rewrites it.
#[test]
fn the_lifecycle_payloads_match_the_committed_fixture() {
    let db = open("fixture");
    let steps = db
        .call_blocking(|conn| {
            let mut steps = Vec::new();
            let item = write::capture(
                conn,
                &NewCapture {
                    id: Some("ios-capture-0000000001".into()),
                    item_type: "note".into(),
                    title: "[agent] from the phone".into(),
                    content: Some("[agent] from the phone".into()),
                    capture_source: Some("inline".into()),
                    processing_status: "complete".into(),
                    ..NewCapture::default()
                },
                DEVICE,
                NOW,
            )?
            .acknowledge();
            let mut take = |name: &str, conn: &Connection| {
                steps.push(json!({ "step": name, "payload": payload(conn, &item.id) }))
            };
            take("capture", conn);
            write::snooze(
                conn,
                &item.id,
                NOW + 86_400_000,
                Some("later"),
                DEVICE,
                NOW + 1,
            )?
            .acknowledge();
            take("snooze", conn);
            write::unsnooze(conn, &item.id, DEVICE, NOW + 2)?.acknowledge();
            take("unsnooze", conn);
            write::archive(conn, &item.id, DEVICE, NOW + 3)?.acknowledge();
            take("archive", conn);
            write::unarchive(conn, &item.id, DEVICE, NOW + 4)?.acknowledge();
            take("unarchive", conn);
            write::mark_filed(
                conn,
                &item.id,
                "Agent Test/[agent] from the phone.md",
                "folder",
                DEVICE,
                NOW + 5,
            )?
            .acknowledge();
            take("file", conn);
            write::undo_file(conn, &item.id, DEVICE, NOW + 6)?.acknowledge();
            take("unfile", conn);
            Ok(steps)
        })
        .expect("lifecycle");
    let fixture = json!({
        "meta": {
            "class": "inbox-ios-payloads",
            "spec": "006-ios-inbox IB028",
            "producer": "crates/memry-core/tests/domain_inbox_write.rs (the iOS core's own writes)",
            "consumer": "apps/desktop/src/main/sync/item-handlers/inbox-handler-ios.test.ts",
        },
        "itemId": "ios-capture-0000000001",
        "steps": steps,
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/inbox-ios-payloads.json"
    );
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&fixture).expect("json")
    );
    if std::env::var("MEMRY_UPDATE_FIXTURES").is_ok() {
        std::fs::write(path, &text).expect("write fixture");
    }
    let committed: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("inbox-ios-payloads.json"))
            .expect("the fixture is JSON");
    assert_eq!(
        committed, fixture,
        "rerun with MEMRY_UPDATE_FIXTURES=1 and commit the change"
    );
}
