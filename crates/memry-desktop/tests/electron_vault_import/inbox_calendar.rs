//! Stage 36d1: the Inbox, the calendar and bookmarks. Each expected payload is the string
//! Electron's handler (`buildPushPayload`) returns for the seeded row.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::queue::{queue, text};
use super::{NOW_MS, Vault, assert_refused, electron_db, import};

const C: &str = "2026-01-02T03:04:05.000Z";
const M: &str = "2026-01-03T03:04:05.000Z";
const S: &str = "2026-01-04T03:04:05.000Z";

fn int(n: i64) -> Value {
    Value::Integer(n)
}

fn seed(conn: &Connection, table: &str, values: &[(&str, Value)]) {
    electron_db::seed(conn, table, values);
}

/// `base` with each column of `extra` set to its value there.
fn with<'a>(mut base: Vec<(&'a str, Value)>, extra: &[(&'a str, Value)]) -> Vec<(&'a str, Value)> {
    for (column, value) in extra {
        base.retain(|(c, _)| c != column);
        base.push((column, value.clone()));
    }
    base
}

fn inbox_item(conn: &Connection, id: &str, extra: &[(&str, Value)]) {
    let values = vec![
        ("id", text(id)),
        ("type", text("link")),
        ("title", text("Article")),
        ("created_at", text(C)),
        ("modified_at", text(M)),
        ("processing_status", text("complete")),
        ("clock", text(r#"{"dev-A":3}"#)),
        ("synced_at", text(S)),
    ];
    seed(conn, "inbox_items", &with(values, extra));
}

fn core(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn payload(core: &Connection, item_type: &str, id: &str) -> String {
    core.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        [item_type, id],
        |row| row.get(0),
    )
    .unwrap()
}

fn job(conn: &Connection, id: &str, item: &str, kind: &str, status: &str, extra: &[(&str, Value)]) {
    let values = vec![
        ("id", text(id)),
        ("item_id", text(item)),
        ("type", text(kind)),
        ("status", text(status)),
        ("run_at", text(M)),
        ("attempts", int(1)),
        ("max_attempts", int(2)),
        ("created_at", text(C)),
        ("updated_at", text(M)),
    ];
    seed(conn, "inbox_jobs", &with(values, extra));
}

#[test]
fn inbox_items_tags_uploads_and_jobs_survive_as_electron_keeps_them() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    // Rows of a gone capture: Electron's cascade normally removes them.
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    inbox_item(
        &conn,
        "inb-1",
        &[
            ("snoozed_until", text("2026-02-01T09:00:00.000Z")),
            ("metadata", text(r#"{"b":1,"a":[1.0]}"#)),
            ("attachment_id", text("att-9")),
            ("source_url", text("https://e.x/a")),
            ("local_only", int(0)),
        ],
    );
    inbox_item(&conn, "inb-2", &[("local_only", Value::Null)]);
    for (id, item, tag, at) in [
        ("tg-1", "inb-1", "Work", C),
        ("tg-2", "inb-1", "work", M),
        ("tg-3", "gone", "x", C),
    ] {
        seed(
            &conn,
            "inbox_item_tags",
            &[
                ("id", text(id)),
                ("item_id", text(item)),
                ("tag", text(tag)),
                ("created_at", text(at)),
            ],
        );
    }
    for item in ["inb-1", "gone"] {
        seed(
            &conn,
            "inbox_attachment_uploads",
            &[
                ("item_id", text(item)),
                ("created_at", int(1_767_000_000_000)),
            ],
        );
    }
    job(
        &conn,
        "j1",
        "inb-1",
        "metadata-scrape",
        "running",
        &[("started_at", text(M))],
    );
    job(
        &conn,
        "j2",
        "inb-1",
        "transcription",
        "complete",
        &[("payload", text(r#"{"k":1}"#)), ("completed_at", text(S))],
    );
    job(&conn, "j3", "inb-1", "thumbnail-generation", "pending", &[]);
    job(
        &conn,
        "j4",
        "inb-2",
        "article-extract",
        "pending",
        &[("payload", text(r#"{"url":"https://e.x/b"}"#))],
    );
    job(
        &conn,
        "j5",
        "inb-1",
        "metadata-scrape",
        "failed",
        &[("updated_at", text(C))],
    );
    job(&conn, "j6", "gone", "metadata-scrape", "pending", &[]);
    queue(&conn, "inbox", "inb-1", "update", "{}", 1_767_000_000);
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    for (table, written, dropped) in [
        ("data.db/inbox_items", 2, 0),
        ("data.db/inbox_item_tags", 1, 2),
        ("data.db/inbox_attachment_uploads", 1, 1),
        ("data.db/inbox_jobs", 2, 4),
    ] {
        let t = &report.tables[table];
        assert_eq!((t.target_count, t.dropped), (written, dropped), "{table}");
    }
    for (reason, n) in [
        ("duplicateInboxTags", 1),
        ("inboxTagsWithoutItem", 1),
        ("inboxUploadsWithoutItem", 1),
        ("inboxJobsWithoutProcessor", 1),
        ("inboxJobsUrlLost", 1),
        ("duplicateInboxJobs", 1),
        ("inboxJobsWithoutItem", 1),
    ] {
        assert_eq!(report.dropped[reason], n, "{reason}");
    }
    assert_eq!(report.notices["inboxJobPayloadsDropped"], 1);

    let core = core(&vault);
    assert_eq!(
        payload(&core, "inbox", "inb-1"),
        format!(
            r#"{{"id":"inb-1","type":"link","title":"Article","content":null,"createdAt":"{C}","modifiedAt":"{M}","filedAt":null,"filedTo":null,"filedAction":null,"snoozedUntil":"2026-02-01T09:00:00.000Z","snoozeReason":null,"viewedAt":null,"processingStatus":"complete","processingError":null,"metadata":{{"b":1,"a":[1]}},"attachmentPath":null,"thumbnailPath":null,"attachmentId":"att-9","transcription":null,"transcriptionStatus":null,"sourceUrl":"https://e.x/a","sourceTitle":null,"captureSource":null,"archivedAt":null,"clock":{{"dev-A":3}},"syncedAt":"{S}","localOnly":false}}"#
        )
    );
    assert!(payload(&core, "inbox", "inb-2").ends_with(r#""localOnly":null}"#));
    assert_eq!(
        one::<String>(
            &core,
            "SELECT clock FROM sync_items WHERE item_id = 'inb-1'"
        ),
        r#"{"dev-A":3}"#
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT attachment_id FROM inbox_view WHERE id = 'inb-1'"
        ),
        "att-9"
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT group_concat(item_id || ':' || tag) FROM inbox_item_tags"
        ),
        "inb-1:Work"
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT group_concat(item_id) FROM inbox_attachment_uploads"
        ),
        "inb-1"
    );
    let jobs: Vec<(String, String, Option<i64>, i64, i64)> = core
        .prepare("SELECT id, status, started_at, attempts, updated_at FROM inbox_jobs ORDER BY id")
        .unwrap()
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let ms = |iso| memry_core::storage::repositories::instants::to_epoch_ms(iso).unwrap();
    assert_eq!(
        jobs,
        vec![
            ("j1".into(), "pending".into(), None, 1, NOW_MS),
            ("j2".into(), "complete".into(), None, 1, ms(M)),
        ]
    );
    assert_eq!(
        one::<String>(&core, "SELECT item_type || ':' || op FROM outbox"),
        "inbox:upsert"
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT source_type || ':' || source_id FROM calendar_push_queue"
        ),
        "inbox_snooze:inb-1"
    );
}

fn source(conn: &Connection, id: &str, provider: &str, clock: Value, extra: &[(&str, Value)]) {
    let values = vec![
        ("id", text(id)),
        ("provider", text(provider)),
        ("kind", text("calendar")),
        ("remote_id", text(&format!("remote-{id}"))),
        ("title", text(id)),
        ("clock", clock),
        ("created_at", text(C)),
        ("modified_at", text(M)),
    ];
    seed(conn, "calendar_sources", &with(values, extra));
}

fn external(conn: &Connection, id: &str, source_id: &str, extra: &[(&str, Value)]) {
    let values = vec![
        ("id", text(id)),
        ("source_id", text(source_id)),
        ("remote_event_id", text(&format!("r-{id}"))),
        ("title", text(id)),
        ("start_at", text("2026-03-04T10:00:00.000Z")),
        ("clock", text(r#"{"dev-A":6}"#)),
        ("created_at", text(C)),
        ("modified_at", text(M)),
    ];
    seed(conn, "calendar_external_events", &with(values, extra));
}

fn seed_calendar(conn: &Connection) {
    source(
        conn,
        "src-g",
        "google",
        text(r#"{"dev-A":1}"#),
        &[
            ("remote_id", text("primary")),
            ("is_primary", int(1)),
            ("is_selected", int(1)),
            ("sync_cursor", text("tok-1")),
            ("sync_status", text("ok")),
            ("last_error", text("boom")),
            ("metadata", text(r#"{"accountEmail":"a@b"}"#)),
        ],
    );
    source(conn, "src-i", "ics", text(r#"{"dev-A":2}"#), &[]);
    // EventKit sources never sync, so Electron never clocks one.
    source(conn, "src-k", "apple-eventkit", Value::Null, &[]);
    source(conn, "src-u", "outlook", text(r#"{"dev-A":4}"#), &[]);
    for (id, title, attendees, field_clocks, target) in [
        (
            "ev-1",
            "Standup",
            text(r#"[{"email":"x@y"}]"#),
            text(r#"{"title":{"dev-A":5}}"#),
            text("src-k"),
        ),
        ("ev-2", "Gym", Value::Null, Value::Null, Value::Null),
    ] {
        seed(
            conn,
            "calendar_events",
            &[
                ("id", text(id)),
                ("title", text(title)),
                ("start_at", text("2026-03-03T18:00:00.000Z")),
                ("attendees", attendees),
                ("field_clocks", field_clocks),
                ("target_calendar_id", target),
                ("clock", text(r#"{"dev-A":5}"#)),
                ("created_at", text(C)),
                ("modified_at", text(M)),
            ],
        );
    }
    seed(
        conn,
        "calendar_bindings",
        &[
            ("id", text("bd-1")),
            ("source_type", text("event")),
            ("source_id", text("ev-1")),
            ("provider", text("google")),
            ("remote_calendar_id", text("primary")),
            ("remote_event_id", text("g-1")),
            ("ownership_mode", text("memry_managed")),
            ("writeback_mode", text("broad")),
            ("last_local_snapshot", text(r#"{"title":"Standup"}"#)),
            ("clock", text(r#"{"dev-A":2}"#)),
            ("created_at", text(C)),
            ("modified_at", text(M)),
        ],
    );
    external(
        conn,
        "x-g",
        "src-g",
        &[
            ("is_all_day", int(1)),
            ("raw_payload", text(r#"{"id":"g-2"}"#)),
        ],
    );
    external(
        conn,
        "calendar_external_event:src-i:u1",
        "src-i",
        &[("attendees", text("[]")), ("clock", Value::Null)],
    );
    external(
        conn,
        "x-i2",
        "src-i",
        &[("archived_at", text(S)), ("clock", Value::Null)],
    );
    external(conn, "x-k", "src-k", &[("clock", Value::Null)]);
    external(conn, "x-u", "src-u", &[]);
    external(conn, "x-o", "gone", &[]);
    seed(
        conn,
        "bookmarks",
        &[
            ("id", text("bm-1")),
            ("item_type", text("note")),
            ("item_id", text("n-1")),
            ("position", int(2)),
            ("created_at", text(C)),
            ("clock", text(r#"{"dev-A":1}"#)),
            ("synced_at", text(S)),
        ],
    );
}

#[test]
fn calendar_rows_and_bookmarks_land_where_electron_keeps_them_with_their_clocks() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    seed_calendar(&conn);
    queue(
        &conn,
        "calendar_event",
        "ev-2",
        "update",
        "{}",
        1_767_000_000,
    );
    queue(
        &conn,
        "calendar_external_event",
        "x-k",
        "update",
        "{}",
        1_767_000_001,
    );
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    for (table, written, dropped) in [
        ("data.db/calendar_sources", 3, 1),
        ("data.db/calendar_events", 2, 0),
        ("data.db/calendar_bindings", 1, 0),
        ("data.db/calendar_external_events", 4, 2),
        ("data.db/bookmarks", 1, 0),
    ] {
        let t = &report.tables[table];
        assert_eq!((t.target_count, t.dropped), (written, dropped), "{table}");
    }
    for (reason, n) in [
        ("eventkitCalendars", 1),
        ("eventkitEvents", 1),
        ("archivedFeedEvents", 1),
        ("queueRowsWithoutRecord", 1),
    ] {
        assert_eq!(report.dropped[reason], n, "{reason}");
    }

    let core = core(&vault);
    for (item_type, id, expected) in [
        (
            "calendar_source",
            "src-g",
            format!(
                r#"{{"provider":"google","kind":"calendar","accountId":null,"remoteId":"primary","title":"src-g","timezone":null,"color":null,"isPrimary":true,"isSelected":true,"isMemryManaged":false,"syncCursor":"tok-1","syncStatus":"ok","lastSyncedAt":null,"metadata":{{"accountEmail":"a@b"}},"archivedAt":null,"clock":{{"dev-A":1}},"createdAt":"{C}","modifiedAt":"{M}"}}"#
            ),
        ),
        (
            "calendar_event",
            "ev-2",
            format!(
                r#"{{"title":"Gym","description":null,"location":null,"startAt":"2026-03-03T18:00:00.000Z","endAt":null,"timezone":"UTC","isAllDay":false,"recurrenceRule":null,"recurrenceExceptions":null,"attendees":null,"reminders":null,"visibility":null,"colorId":null,"conferenceData":null,"archivedAt":null,"targetCalendarId":null,"parentEventId":null,"originalStartTime":null,"clock":{{"dev-A":5}},"createdAt":"{C}","modifiedAt":"{M}"}}"#
            ),
        ),
        (
            "calendar_binding",
            "bd-1",
            format!(
                r#"{{"sourceType":"event","sourceId":"ev-1","provider":"google","remoteCalendarId":"primary","remoteEventId":"g-1","ownershipMode":"memry_managed","writebackMode":"broad","remoteVersion":null,"lastLocalSnapshot":{{"title":"Standup"}},"archivedAt":null,"clock":{{"dev-A":2}},"createdAt":"{C}","modifiedAt":"{M}"}}"#
            ),
        ),
        (
            "calendar_external_event",
            "x-g",
            format!(
                r#"{{"sourceId":"src-g","remoteEventId":"r-x-g","remoteEtag":null,"remoteUpdatedAt":null,"title":"x-g","description":null,"location":null,"startAt":"2026-03-04T10:00:00.000Z","endAt":null,"timezone":null,"isAllDay":true,"status":"confirmed","recurrenceRule":null,"attendees":null,"reminders":null,"visibility":null,"colorId":null,"conferenceData":null,"rawPayload":{{"id":"g-2"}},"archivedAt":null,"clock":{{"dev-A":6}},"createdAt":"{C}","modifiedAt":"{M}"}}"#
            ),
        ),
        (
            "bookmark",
            "bm-1",
            format!(
                r#"{{"id":"bm-1","itemType":"note","itemId":"n-1","position":2,"createdAt":"{C}","clock":{{"dev-A":1}},"syncedAt":"{S}"}}"#
            ),
        ),
    ] {
        assert_eq!(payload(&core, item_type, id), expected, "{item_type} {id}");
    }
    assert!(payload(&core, "calendar_event", "ev-1").contains(
        r#""targetCalendarId":"src-k","parentEventId":null,"originalStartTime":null,"clock":{"dev-A":5},"fieldClocks":{"title":{"dev-A":5}}"#
    ));
    assert_eq!(
        one::<String>(
            &core,
            "SELECT field_clocks FROM calendar_events WHERE id = 'ev-1'"
        ),
        r#"{"title":{"dev-A":5}}"#
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT created_at_raw FROM calendar_bindings WHERE id = 'bd-1'"
        ),
        C
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT sync_cursor FROM calendar_sources WHERE id = 'src-g'"
        ),
        "tok-1"
    );
    // The synced mirrors: Google, an unknown provider's and an orphan's events.
    assert_eq!(
        one::<String>(
            &core,
            "SELECT group_concat(item_id) FROM (SELECT item_id FROM sync_items
              WHERE item_type = 'calendar_external_event' ORDER BY item_id)"
        ),
        "x-g,x-o,x-u"
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT id || '|' || source_id || '|' || attendees || '|' || modified_at
               FROM calendar_local_events"
        ),
        format!(
            "calendar_external_event:src-i:u1|src-i|[]|{}",
            memry_core::storage::repositories::instants::to_epoch_ms(M).unwrap()
        )
    );
    assert_eq!(
        one::<i64>(
            &core,
            "SELECT count(*) FROM sync_items WHERE item_id IN ('src-k', 'x-k')"
        ),
        0
    );
    assert_eq!(
        one::<String>(
            &core,
            "SELECT source_type || ':' || source_id FROM calendar_push_queue"
        ),
        "event:ev-2"
    );
}

#[test]
fn a_local_only_inbox_item_is_refused() {
    let vault = Vault::new();
    inbox_item(&vault.data_conn(), "inb-1", &[("local_only", int(1))]);
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::MalformedRow {
                table: "inbox_items",
                ..
            }
        )
    });
}

/// A source table and a seed of one row in it.
type Case = (&'static str, fn(&Connection));

/// Electron re-pushes these at its next start (dirty sweeps, `seedUnclocked`); the import has
/// no replay for them yet, so it refuses rather than stage the vault without the push.
#[test]
fn rows_electron_would_re_push_at_start_are_refused() {
    let cases: [Case; 5] = [
        ("inbox_items", |c| {
            inbox_item(c, "i", &[("synced_at", Value::Null)])
        }),
        ("inbox_items", |c| {
            inbox_item(c, "i", &[("modified_at", text(S)), ("synced_at", text(M))])
        }),
        ("bookmarks", |c| {
            seed(
                c,
                "bookmarks",
                &[
                    ("id", text("b")),
                    ("item_type", text("note")),
                    ("item_id", text("n")),
                    ("clock", text(r#"{"d":1}"#)),
                ],
            )
        }),
        ("calendar_events", |c| {
            seed(
                c,
                "calendar_events",
                &[
                    ("id", text("e")),
                    ("title", text("t")),
                    ("start_at", text(C)),
                ],
            )
        }),
        ("calendar_external_events", |c| {
            source(c, "s", "google", text(r#"{"d":1}"#), &[]);
            external(c, "x", "s", &[("clock", Value::Null)]);
        }),
    ];
    for (table, seed_case) in cases {
        let vault = Vault::new();
        seed_case(&vault.data_conn());
        assert_refused(
            &vault,
            |e| matches!(e, ImportError::NotReady { detail, .. } if detail.contains(table)),
        );
    }
}

#[test]
fn a_calendar_json_column_electron_cannot_parse_is_refused() {
    let vault = Vault::new();
    seed(
        &vault.data_conn(),
        "calendar_events",
        &[
            ("id", text("e")),
            ("title", text("t")),
            ("start_at", text(C)),
            ("attendees", text("[{bad")),
            ("clock", text(r#"{"d":1}"#)),
        ],
    );
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::MalformedRow {
                table: "calendar_events",
                ..
            }
        )
    });
}
