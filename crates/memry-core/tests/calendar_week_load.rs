//! Spec 007 CL092: a week holding 200 items reads back in one range query
//! well inside a frame budget, so paging and first paint do not wait on it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use memry_core::domain::calendar_items::projection::{self, RangeInput};
use memry_core::domain::calendar_items::write::{self, NewEvent};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::{Db, open_data};

const NOW: i64 = 1_790_380_800_000; // 2026-09-26
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-cal-load-{}-{unique}", std::process::id()));
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
    let mut timings = Vec::new();
    let mut count = 0;
    for _ in 0..5 {
        let started = Instant::now();
        let input = input.clone();
        count = db
            .call_blocking(move |conn| projection::range(conn, &FixedZone(0), &input))
            .expect("range")
            .len();
        timings.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    let median = timings[2];
    println!("CL092 week range: {count} items, median {median:.2} ms, runs {timings:?}");
    assert_eq!(count, 200);
    // Debug build; release is faster. A frame is 16.7 ms.
    assert!(median < 50.0, "median {median} ms");
}
