//! Writing Memry items to CalDAV and Google from the phone (spec 007 CL070,
//! CL074, CL075): a local change queues exactly its item, routing picks the
//! one provider, the first push creates the binding, an unchanged item sends
//! nothing, a pulled object Memry wrote flows back into its item, a foreign
//! object mirrors, and a deleted item plans a delete.

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::ical::{IcalWindow, IcalZones};
use memry_core::domain::calendar_items::providers::{self, Target, bindings, caldav, ical_write};
use memry_core::domain::calendar_items::write::{self, EventPatch, NewEvent};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::{Db, open_data};
use serde_json::json;

const NOW: i64 = 1_773_000_000_000; // 2026-03-08
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-cal-push-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch");
    open_data(&dir.join("data.db")).expect("open data.db")
}

const CAL: &str = "https://localhost:5232/agent/work/";

fn utc() -> CalendarZone {
    CalendarZone {
        identifier: "UTC".into(),
        base_offset_ms: 0,
        transitions: vec![],
    }
}

#[test]
fn an_event_routes_to_caldav_pushes_once_and_follows_the_server() {
    let db = open();
    // A CalDAV account with one calendar, connected on this device.
    let account = db
        .call_blocking(|conn| {
            caldav::connect(
                conn,
                &caldav::Connect {
                    server_url: "https://localhost:5232/".into(),
                    username: "agent".into(),
                    principal_url: "https://localhost:5232/agent/".into(),
                    home_url: "https://localhost:5232/agent/".into(),
                    preset: Some("self-hosted".into()),
                    calendars: vec![caldav::DiscoveredCalendar {
                        url: CAL.into(),
                        display_name: "Work".into(),
                        color: None,
                        timezone: None,
                        supports_sync_collection: true,
                    }],
                    selected: None,
                },
                "phone",
                NOW,
            )
        })
        .expect("connect");
    assert!(account.starts_with("caldav-"));
    // Connecting never archives the account row itself.
    let live_rows: i64 = db
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM calendar_sources WHERE provider = 'caldav' AND archived_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .expect("count"))
        })
        .expect("count");
    assert_eq!(live_rows, 2);

    // A new event aimed at that calendar is queued and routed to CalDAV.
    let event_id = db
        .call_blocking(|conn| {
            write::create_event(
                conn,
                &NewEvent {
                    title: "[agent] CalDAV push".into(),
                    start_at: "2026-03-10T09:00:00.000Z".into(),
                    end_at: Some("2026-03-10T10:00:00.000Z".into()),
                    timezone: "UTC".into(),
                    target_calendar_id: Some(CAL.into()),
                    ..NewEvent::default()
                },
                "phone",
                NOW,
            )
        })
        .expect("create");
    let target = Target {
        source_type: "event".into(),
        source_id: event_id.clone(),
    };
    let queued = db
        .call_blocking(|conn| providers::queue(conn))
        .expect("queue");
    assert_eq!(queued.iter().filter(|q| q.target == target).count(), 1);
    let t = target.clone();
    let route = db
        .call_blocking(move |conn| providers::route(conn, &t))
        .expect("route");
    assert_eq!(
        (route.provider.as_str(), route.reason.as_str()),
        ("caldav", "event_target")
    );

    // The first push: a new object, then the binding.
    let t = target.clone();
    let input = db
        .call_blocking(move |conn| {
            providers::upsert_input(conn, &t, &FixedZone(0), "UTC", &Default::default())
        })
        .expect("input")
        .expect("on the calendar");
    let body = ical_write::new_object(&input, "memry-1", None, &FixedZone(0), NOW);
    let href = format!("{CAL}memry-1.ics");
    let (t, h, b, i) = (target.clone(), href.clone(), body.clone(), input.clone());
    db.call_blocking(move |conn| {
        let mut snapshot = i;
        snapshot["caldavRaw"] = json!(b);
        bindings::record_push(
            conn,
            "caldav",
            &t,
            &bindings::Written {
                calendar_id: CAL.into(),
                event_id: h,
                etag: Some("\"e1\"".into()),
            },
            snapshot,
            "phone",
            NOW,
        )?;
        providers::dequeue(conn, &t)
    })
    .expect("recorded");
    let t = target.clone();
    let binding = db
        .call_blocking(move |conn| bindings::find(conn, "caldav", &t))
        .expect("find")
        .expect("bound");
    assert!(
        bindings::same_as_snapshot(&binding, &input),
        "an unchanged item sends nothing"
    );

    // The server edits the object: a pull flows the new title back into the
    // event, and the binding follows.
    let edited = body.replace(
        "SUMMARY:[agent] CalDAV push",
        "SUMMARY:[agent] Edited on the server",
    );
    let e = edited.clone();
    db.call_blocking(move |conn| {
        caldav::apply_pull(
            conn,
            &caldav::calendar_source_id(CAL),
            CAL,
            &caldav::Pull {
                objects: vec![caldav::Object {
                    href: href.clone(),
                    etag: Some("\"e2\"".into()),
                    data: e,
                }],
                removed: vec![],
                full: true,
                cursor: Some("sync-token:2".into()),
            },
            IcalWindow {
                start_ms: NOW - 86_400_000 * 30,
                end_ms: NOW + 86_400_000 * 30,
            },
            &IcalZones {
                named: Default::default(),
                local: utc(),
            },
            &FixedZone(0),
            "UTC",
            "phone",
            NOW + 1,
        )
    })
    .expect("pull");
    let id = event_id.clone();
    let title: String = db
        .call_blocking(move |conn| {
            conn.query_row(
                "SELECT title FROM calendar_events WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect("title");
    assert_eq!(title, "[agent] Edited on the server");
    // Nothing mirrored for Memry's own object, nothing left to push.
    let mirrored: i64 = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM calendar_external_events WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect("count");
    assert_eq!(mirrored, 0);
    assert!(
        db.call_blocking(|conn| providers::queue(conn))
            .expect("queue")
            .iter()
            .all(|q| q.target != target)
    );

    // A local edit queues again; a delete of the event makes the item leave
    // the calendar, which the plan turns into a delete of the bound object.
    let id = event_id.clone();
    db.call_blocking(move |conn| {
        write::update_event(
            conn,
            &id,
            &EventPatch {
                title: Some("[agent] Edited here".into()),
                ..EventPatch::default()
            },
            "phone",
            NOW + 2,
        )
    })
    .expect("update");
    assert!(
        db.call_blocking(|conn| providers::queue(conn))
            .expect("queue")
            .iter()
            .any(|q| q.target == target)
    );
    let id = event_id.clone();
    db.call_blocking(move |conn| write::delete_event(conn, &id, "phone", NOW + 3))
        .expect("delete");
    let t = target.clone();
    let gone = db
        .call_blocking(move |conn| {
            providers::upsert_input(conn, &t, &FixedZone(0), "UTC", &Default::default())
        })
        .expect("input");
    assert!(gone.is_none());
}

#[test]
fn a_foreign_object_mirrors_and_leaves_when_the_server_drops_it() {
    let db = open();
    db.call_blocking(|conn| {
        caldav::connect(
            conn,
            &caldav::Connect {
                server_url: "https://localhost:5232/".into(),
                username: "agent".into(),
                principal_url: "https://localhost:5232/agent/".into(),
                home_url: "https://localhost:5232/agent/".into(),
                preset: None,
                calendars: vec![caldav::DiscoveredCalendar {
                    url: CAL.into(),
                    display_name: "Work".into(),
                    color: None,
                    timezone: None,
                    supports_sync_collection: false,
                }],
                selected: None,
            },
            "phone",
            NOW,
        )
    })
    .expect("connect");
    let source = caldav::calendar_source_id(CAL);
    let data = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s1\r\nSUMMARY:Series\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T093000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let apply = |objects: Vec<caldav::Object>, now: i64| {
        let source = source.clone();
        db.call_blocking(move |conn| {
            caldav::apply_pull(
                conn,
                &source,
                CAL,
                &caldav::Pull {
                    objects,
                    removed: vec![],
                    full: true,
                    cursor: Some("ctag:1".into()),
                },
                IcalWindow {
                    start_ms: NOW - 86_400_000 * 30,
                    end_ms: NOW + 86_400_000 * 30,
                },
                &IcalZones {
                    named: Default::default(),
                    local: utc(),
                },
                &FixedZone(0),
                "UTC",
                "phone",
                now,
            )
        })
        .expect("pull")
    };
    assert_eq!(
        apply(
            vec![caldav::Object {
                href: format!("{CAL}s1.ics"),
                etag: Some("1".into()),
                data: data.into()
            }],
            NOW
        ),
        3
    );
    assert_eq!(
        apply(
            vec![caldav::Object {
                href: format!("{CAL}s1.ics"),
                etag: Some("1".into()),
                data: data.into()
            }],
            NOW + 1
        ),
        0,
        "an unchanged object writes nothing"
    );
    assert_eq!(
        apply(vec![], NOW + 2),
        3,
        "a full listing without the object removes its rows"
    );
}

const SERIES: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Istanbul\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSEQUENCE:0\r\nSUMMARY:[agent] Weekly\r\nDTSTART;TZID=Europe/Istanbul:20260928T100000\r\nDTEND;TZID=Europe/Istanbul:20260928T103000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const SECOND: &str = "2026-10-05T07:00:00.000Z";

fn series_zones() -> IcalZones {
    IcalZones {
        named: Default::default(),
        local: utc(),
    }
}

fn series_instances(text: &str) -> Vec<(String, String, String)> {
    let window = IcalWindow {
        start_ms: 1_790_000_000_000,
        end_ms: 1_792_000_000_000,
    };
    memry_core::domain::calendar_items::ical::parse_feed(text, window, &series_zones())
        .expect("parses")
        .events
        .into_iter()
        .map(|e| (e.remote_event_id, e.title, e.start_at))
        .collect()
}

#[test]
fn editing_one_occurrence_adds_an_override_and_keeps_the_series() {
    let rid = memry_core::storage::repositories::instants::to_epoch_ms(SECOND).expect("rid");
    let event = json!({"sourceType": "event", "sourceId": "e1", "title": "[agent] Moved one",
        "startAt": "2026-10-05T09:00:00.000Z", "endAt": "2026-10-05T09:30:00.000Z",
        "isAllDay": false, "timezone": "UTC", "recurrence": null});
    let zones = series_zones();
    let text = ical_write::patch_object(
        SERIES,
        &event,
        None,
        &FixedZone(0),
        Some((rid, &zones)),
        NOW,
    )
    .expect("patch");
    assert!(
        text.contains("RECURRENCE-ID;TZID=Europe/Istanbul:20261005T100000"),
        "{text}"
    );
    let instances = series_instances(&text);
    assert_eq!(instances.len(), 3);
    assert_eq!(instances[1].1, "[agent] Moved one");
    assert_eq!(instances[1].0, format!("weekly::{SECOND}"));
    assert_eq!(instances[0].1, "[agent] Weekly");

    // Patching again reuses that override instead of adding a second.
    let again =
        ical_write::patch_object(&text, &event, None, &FixedZone(0), Some((rid, &zones)), NOW)
            .expect("patch again");
    assert_eq!(again.matches("RECURRENCE-ID").count(), 1);

    // Deleting the occurrence drops the override and excludes it.
    let excluded = ical_write::exclude_occurrence(&again, rid, &zones, NOW).expect("exclude");
    assert!(!excluded.contains("RECURRENCE-ID"));
    assert!(
        excluded.contains("EXDATE;TZID=Europe/Istanbul:20261005T100000"),
        "{excluded}"
    );
    let left: Vec<String> = series_instances(&excluded)
        .into_iter()
        .map(|i| i.2)
        .collect();
    assert_eq!(
        left,
        vec!["2026-09-28T07:00:00.000Z", "2026-10-12T07:00:00.000Z"]
    );
}

#[test]
fn a_binding_splits_its_occurrence_and_finds_the_promoted_object() {
    assert_eq!(
        bindings::caldav_parts(&format!("{CAL}weekly.ics::{SECOND}")),
        (format!("{CAL}weekly.ics").as_str(), Some(SECOND))
    );
    assert_eq!(bindings::caldav_parts(CAL), (CAL, None));
    let db = open();
    let href = format!("{CAL}weekly.ics");
    let raw = json!({"href": href, "ical": SERIES}).to_string();
    let (h, r) = (href.clone(), raw.clone());
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO calendar_external_events (id, source_id, remote_event_id, title, start_at, is_all_day, status, raw_payload, created_at, modified_at)
             VALUES ('x1', 's', ?1, 't', '2026-09-28T07:00:00.000Z', 0, 'confirmed', ?2, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
            rusqlite::params![format!("{h}::{SECOND}"), r],
        )
        .map_err(|e| memry_core::api::errors::StorageError::Failed { what: e.to_string() })?;
        Ok(())
    })
    .expect("mirror row");
    let binding = bindings::Binding {
        id: "b".into(),
        remote_calendar_id: CAL.into(),
        remote_event_id: format!("{href}::2026-09-28T07:00:00.000Z"),
        remote_version: None,
        snapshot: None,
    };
    let stored = db
        .call_blocking(move |conn| bindings::stored_object(conn, &binding))
        .expect("lookup");
    assert_eq!(stored.as_deref(), Some(SERIES));
}

fn connect_work(db: &Db) {
    db.call_blocking(|conn| {
        caldav::connect(
            conn,
            &caldav::Connect {
                server_url: "https://localhost:5232/".into(),
                username: "agent".into(),
                principal_url: "https://localhost:5232/agent/".into(),
                home_url: "https://localhost:5232/agent/".into(),
                preset: None,
                calendars: vec![caldav::DiscoveredCalendar {
                    url: CAL.into(),
                    display_name: "Work".into(),
                    color: None,
                    timezone: None,
                    supports_sync_collection: true,
                }],
                selected: None,
            },
            "phone",
            NOW,
        )
    })
    .expect("connect");
}

fn pull(db: &Db, objects: Vec<caldav::Object>, removed: Vec<String>) {
    db.call_blocking(move |conn| {
        caldav::apply_pull(
            conn,
            &caldav::calendar_source_id(CAL),
            CAL,
            &caldav::Pull {
                objects,
                removed,
                full: false,
                cursor: None,
            },
            IcalWindow {
                start_ms: 1_789_000_000_000,
                end_ms: 1_793_000_000_000,
            },
            &series_zones(),
            &FixedZone(0),
            "UTC",
            "phone",
            NOW + 1,
        )
    })
    .expect("pull");
}

fn query<T: rusqlite::types::FromSql + Send + 'static>(db: &Db, sql: &'static str) -> Vec<T> {
    db.call_blocking(move |conn| {
        let mut stmt = conn.prepare(sql).expect("prepare");
        Ok(stmt
            .query_map([], |r| r.get(0))
            .expect("query")
            .collect::<Result<Vec<T>, _>>()
            .expect("rows"))
    })
    .expect("query")
}

#[test]
fn a_bound_occurrence_follows_the_server_and_the_rest_of_the_series_mirrors() {
    let db = open();
    connect_work(&db);
    let event_id = db
        .call_blocking(|conn| {
            write::create_event(
                conn,
                &NewEvent {
                    title: "[agent] Weekly".into(),
                    start_at: SECOND.into(),
                    end_at: Some("2026-10-05T07:30:00.000Z".into()),
                    timezone: "UTC".into(),
                    target_calendar_id: Some(CAL.into()),
                    ..NewEvent::default()
                },
                "phone",
                NOW,
            )
        })
        .expect("create");
    let href = format!("{CAL}weekly.ics");
    let target = Target {
        source_type: "event".into(),
        source_id: event_id.clone(),
    };
    let (t, h) = (target.clone(), href.clone());
    db.call_blocking(move |conn| {
        bindings::record_push(
            conn,
            "caldav",
            &t,
            &bindings::Written {
                calendar_id: CAL.into(),
                event_id: format!("{h}::{SECOND}"),
                etag: Some("\"e1\"".into()),
            },
            json!({}),
            "phone",
            NOW,
        )
    })
    .expect("bound");

    // The server renames that occurrence (an override) and keeps the series.
    let rid = memry_core::storage::repositories::instants::to_epoch_ms(SECOND).expect("rid");
    let zones = series_zones();
    let renamed = json!({"sourceType": "event", "sourceId": "x", "title": "[agent] Renamed on server",
        "startAt": SECOND, "endAt": "2026-10-05T07:30:00.000Z", "isAllDay": false, "timezone": "UTC"});
    let data = ical_write::patch_object(
        SERIES,
        &renamed,
        None,
        &FixedZone(0),
        Some((rid, &zones)),
        NOW,
    )
    .expect("override");
    pull(
        &db,
        vec![caldav::Object {
            href: href.clone(),
            etag: Some("\"e2\"".into()),
            data,
        }],
        vec![],
    );
    let titles: Vec<String> = query(
        &db,
        "SELECT title FROM calendar_events WHERE deleted_at IS NULL",
    );
    assert_eq!(titles, vec!["[agent] Renamed on server"]);
    let mirrored: Vec<String> = query(
        &db,
        "SELECT remote_event_id FROM calendar_external_events WHERE deleted_at IS NULL ORDER BY start_at",
    );
    assert_eq!(
        mirrored.len(),
        2,
        "the bound occurrence is not mirrored: {mirrored:?}"
    );
    assert!(mirrored.iter().all(|m| !m.ends_with(SECOND)));

    // The server deletes the object: the event follows, the binding retires.
    pull(&db, vec![], vec![href]);
    let live: Vec<String> = query(
        &db,
        "SELECT id FROM calendar_events WHERE deleted_at IS NULL",
    );
    assert!(live.is_empty(), "{live:?}");
    let bound: Vec<String> = query(
        &db,
        "SELECT id FROM calendar_bindings WHERE archived_at IS NULL",
    );
    assert!(bound.is_empty());
}
