//! Inbox reads (spec 006 IB013) over rows applied through the real pull path.
//!
//! Each expectation is desktop's definition applied by hand to the fixture:
//! `queries.ts` (list, archived, filing history, type counts), `snooze.ts`
//! (snoozed), `stats.ts` (stale, today, week, streak, age buckets, average),
//! `reminder-panel.ts` (Upcoming / Past).

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::inbox::{self, panel, stats};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

/// 2026-09-24T12:00:00Z, a Thursday.
const NOW: i64 = 1_790_251_200_000;
const DAY: i64 = 86_400_000;
const HOUR: i64 = 3_600_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-inbox-queries-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn iso(ms: i64) -> String {
    instants::to_iso8601(ms).expect("in range")
}

fn put(conn: &Connection, id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    apply_inbound(conn, &record, NOW).expect("apply");
}

fn row(kind: &str, title: &str, created: i64) -> Value {
    json!({ "type": kind, "title": title, "createdAt": iso(created), "clock": { "d": 1 } })
}

/// Eight captures covering every state the reads distinguish.
fn seed(conn: &Connection) {
    put(conn, "a-link", {
        let mut v = row("link", "Fresh link", NOW - HOUR);
        v["sourceUrl"] = json!("https://example.com/agent/1");
        v["processingStatus"] = json!("pending");
        v
    });
    put(conn, "b-note", {
        let mut v = row("note", "Aging note", NOW - 4 * DAY);
        v["content"] = json!("Pick up the cable before Friday, then the dentist.");
        v
    });
    put(conn, "c-stale", row("voice", "Stale memo", NOW - 9 * DAY));
    put(conn, "d-snoozed", {
        let mut v = row("image", "Snoozed image", NOW - 2 * DAY);
        v["snoozedUntil"] = json!(iso(NOW + DAY));
        v
    });
    put(conn, "e-archived", {
        let mut v = row("pdf", "Archived pdf about ramen", NOW - 3 * DAY);
        v["archivedAt"] = json!(iso(NOW - HOUR));
        v
    });
    // Filed today (captured two days ago) and yesterday.
    put(conn, "f-filed", {
        let mut v = row("link", "Filed today", NOW - 2 * DAY);
        v["filedAt"] = json!(iso(NOW - 2 * HOUR));
        v["filedTo"] = json!("Reading/Filed today.md");
        v["filedAction"] = json!("folder");
        v
    });
    put(conn, "g-filed", {
        let mut v = row("note", "Filed yesterday", NOW - 2 * DAY);
        v["filedAt"] = json!(iso(NOW - DAY));
        v["filedTo"] = json!("Work/Plans/Filed yesterday.md");
        v["filedAction"] = json!("note");
        v
    });
    put(conn, "h-reminder", {
        let mut v = row("reminder", "Decide on pricing", NOW - 5 * HOUR);
        v["metadata"] = json!({
            "reminderId": "rem_1", "targetType": "task", "targetId": "task-1",
            "targetTitle": "Decide on pricing", "remindAt": iso(NOW - 5 * HOUR),
            "projectId": "proj-1",
        });
        v
    });
}

#[test]
fn the_list_holds_active_captures_newest_first() {
    let db = open("list");
    db.call_blocking(|conn| {
        seed(conn);
        let ids: Vec<String> = inbox::list_active(conn, false)?
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, ["a-link", "h-reminder", "b-note", "c-stale"]);
        let with_snoozed = inbox::list_active(conn, true)?;
        assert_eq!(with_snoozed.len(), 5);
        let counts = inbox::type_counts(conn)?;
        let count = |t: &str| counts.iter().find(|(k, _)| k == t).map(|(_, n)| *n);
        assert_eq!(count("link"), Some(1));
        assert_eq!(count("image"), Some(0), "snoozed is not active");
        assert_eq!(count("video"), Some(0));
        assert_eq!(counts.len(), 9);
        assert_eq!(inbox::reviewable_count(conn)?, 4);
        assert_eq!(inbox::fetching_count(conn)?, 1);
        Ok(())
    })
    .expect("list");
}

#[test]
fn archived_snoozed_history_and_recent_folders() {
    let db = open("views");
    db.call_blocking(|conn| {
        seed(conn);
        let archived = inbox::archived(conn, Some("ramen"), 50, 0)?;
        assert_eq!(archived.len(), 1);
        assert!(inbox::archived(conn, Some("sushi"), 50, 0)?.is_empty());
        assert_eq!(inbox::snoozed(conn)?[0].id, "d-snoozed");
        assert!(inbox::due_snoozed(conn, NOW)?.is_empty());
        assert_eq!(inbox::due_snoozed(conn, NOW + 2 * DAY)?.len(), 1);
        let history: Vec<String> = inbox::filing_history(conn, 6)?
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(history, ["f-filed", "g-filed"]);
        assert_eq!(inbox::recent_folders(conn, 5)?, ["Reading", "Work/Plans"]);
        let dup = inbox::duplicate_by_url(conn, "https://example.com/agent/1")?;
        assert_eq!(dup.map(|i| i.id).as_deref(), Some("a-link"));
        let by_content = inbox::duplicate_by_content(
            conn,
            "Pick up the cable before Friday, then the dentist.",
        )?;
        assert_eq!(by_content.map(|i| i.id).as_deref(), Some("b-note"));
        assert!(inbox::duplicate_by_content(conn, "short")?.is_none());
        Ok(())
    })
    .expect("views");
}

#[test]
fn stats_match_desktops_definitions() {
    let db = open("stats");
    db.call_blocking(|conn| {
        seed(conn);
        let s = stats::stats(conn, NOW, stats::DEFAULT_STALE_DAYS)?;
        assert_eq!(s.total_items, 4);
        assert_eq!(s.stale_count, 1);
        assert_eq!(s.snoozed_count, 1);
        assert_eq!(s.captured_today, 2, "a-link and h-reminder, UTC today");
        assert_eq!(s.processed_today, 1);
        assert_eq!(s.processed_this_week, 2);
        // Captured on UTC days >= today-7: all but c-stale (9 days).
        assert_eq!(s.captured_this_week, 7);
        assert_eq!(s.capture_process_ratio_tenths, 35);
        assert_eq!(s.process_rate, 29);
        assert_eq!((s.age_fresh, s.age_aging, s.age_stale), (2, 1, 1));
        assert_eq!(s.oldest_item_days, 9);
        assert_eq!(s.current_streak, 2);
        // f: 46h, g: 24h -> 35h = 2100 minutes.
        assert_eq!(s.avg_time_to_process, 2100);
        assert_eq!(s.filed_this_week, 2);
        let p = stats::patterns(conn, NOW)?;
        assert_eq!(p.heatmap.len(), 24);
        assert_eq!(p.types[0], ("link".to_owned(), 2, 25));
        assert!(p.peak.is_some());
        Ok(())
    })
    .expect("stats");
}

#[test]
fn the_panel_splits_upcoming_and_past() {
    let db = open("panel");
    db.call_blocking(|conn| {
        seed(conn);
        let p = panel::panel(conn, NOW)?;
        assert_eq!(p.upcoming.len(), 1);
        assert_eq!(p.upcoming[0].key, "inbox:d-snoozed");
        assert!(p.upcoming[0].target.is_none());
        assert_eq!(p.past.len(), 1);
        let target = p.past[0].target.as_ref().expect("a target");
        assert_eq!(
            (target.target_type.as_str(), target.target_id.as_str()),
            ("task", "task-1")
        );
        assert_eq!(target.project_id.as_deref(), Some("proj-1"));
        Ok(())
    })
    .expect("panel");
}
