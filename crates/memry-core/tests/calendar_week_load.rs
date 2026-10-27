//! Spec 007 CL092: a week holding 200 items reads back in one range query
//! in a bounded number of SQL statements, so paging and first paint do not
//! wait on it. Counted in statements, not milliseconds, so the bound holds on
//! any machine.

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::domain::calendar_items::projection::{self, RangeInput};
use memry_core::domain::calendar_items::write::{self, NewEvent};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::{Db, open_data};
use rusqlite::trace::TraceEventCodes;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);

const NOW: i64 = 1_790_380_800_000; // 2026-09-26
fn open() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-cal-load-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("scratch");
    open_data(&dir.join("data.db")).expect("open data.db")
}

#[test]
fn a_week_with_200_items_reads_in_one_fast_query() {
    let db = open();
    db.call_blocking(|conn| {
        for i in 0..200_i64 {
            let day = i % 7;
            let minute = (i * 37) % (14 * 60);
            let start = NOW + 2 * 86_400_000 + day * 86_400_000 + (7 * 60 + minute) * 60_000;
            let iso =
                |ms: i64| memry_core::storage::repositories::instants::to_iso8601(ms).expect("iso");
            write::create_event(
                conn,
                &NewEvent {
                    title: format!("[agent] Load {i}"),
                    start_at: iso(start),
                    end_at: Some(iso(start + 45 * 60_000)),
                    timezone: "UTC".into(),
                    ..NewEvent::default()
                },
                "phone",
                NOW,
            )?;
        }
        Ok(())
    })
    .expect("seed");
    let input = RangeInput {
        start_at: "2026-09-28T00:00:00.000Z".into(),
        end_at: "2026-10-05T00:00:00.000Z".into(),
        include_unselected_sources: false,
        include_external: true,
        external_providers: None,
        enabled_property_names: vec![],
        show_notes_by_created: false,
        local_timezone: "UTC".into(),
    };
    let mut count = 0;
    let mut statements = 0;
    for _ in 0..5 {
        let input = input.clone();
        let (found, used) = db
            .call_blocking(move |conn| {
                STATEMENTS.store(0, Ordering::SeqCst);
                conn.trace_v2(
                    TraceEventCodes::SQLITE_TRACE_STMT,
                    Some(|_| {
                        STATEMENTS.fetch_add(1, Ordering::SeqCst);
                    }),
                );
                let found = projection::range(conn, &FixedZone(0), &input);
                conn.trace_v2(TraceEventCodes::empty(), None);
                Ok((found, STATEMENTS.load(Ordering::SeqCst)))
            })
            .expect("range");
        count = found.expect("range").len();
        statements = used;
    }
    println!("CL092 week range: {count} items, {statements} statements");
    assert_eq!(count, 200);
    // One query plus a few lookups, not one query per item (200 items).
    assert!(statements <= 20, "{statements} statements for 200 items");
}
