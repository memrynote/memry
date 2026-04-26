//! M2 acceptance bench — 1000-row list query p50 < 20ms.
//!
//! Spec §5.5: every M2 ship-gate sweep includes a release-build run of this
//! bench so SQLite-path regressions surface before merge. Debug builds are
//! ~10× slower on rusqlite (Risk #7) — use `cargo run --release`.
//!
//! Strategy:
//!   1. Open an in-memory DB via `Db::open_memory` (same migration runner +
//!      WAL/foreign-key PRAGMAs as production minus journal_mode).
//!   2. Seed a single project, then 1000 tasks under it inside one
//!      `unchecked_transaction` so all rows commit atomically.
//!   3. Warm-up: 5 list iterations (statement-cache priming).
//!   4. Measure: 100 iterations of the SELECT, recording per-iteration
//!      `Instant` deltas in microseconds.
//!   5. Sort, report p50/p95, assert p50 < 20_000µs.
//!
//! Run:
//!   cargo run --release --example bench_m2 --features test-helpers

use memry_desktop_tauri_lib::db::Db;
use std::time::Instant;

const ROW_COUNT: usize = 1000;
const WARMUP_ITERS: usize = 5;
const MEASURE_ITERS: usize = 100;
const P50_THRESHOLD_US: u64 = 20_000;
const SELECT_QUERY: &str = "SELECT id, title, priority, position FROM tasks
                            WHERE project_id = 'bench-p' ORDER BY position
                            LIMIT 1000";

fn main() {
    let db = Db::open_memory().expect("open memory db");
    let conn = db.conn().expect("acquire connection guard");

    conn.execute(
        "INSERT INTO projects (id, name, color) VALUES (?1, ?2, ?3)",
        rusqlite::params!["bench-p", "Bench", "#000"],
    )
    .expect("seed project");

    {
        let tx = conn.unchecked_transaction().expect("open seed tx");
        for i in 0..ROW_COUNT {
            tx.execute(
                "INSERT INTO tasks (id, project_id, title, priority, position)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![format!("t{i}"), "bench-p", format!("Task {i}"), 0, i as i64],
            )
            .expect("seed task");
        }
        tx.commit().expect("commit seed tx");
    }

    for _ in 0..WARMUP_ITERS {
        let mut stmt = conn.prepare(SELECT_QUERY).expect("prepare warmup");
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query warmup")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows.len(), ROW_COUNT, "warmup row count");
    }

    let mut samples: Vec<u64> = Vec::with_capacity(MEASURE_ITERS);
    for _ in 0..MEASURE_ITERS {
        let start = Instant::now();
        let mut stmt = conn.prepare(SELECT_QUERY).expect("prepare measure");
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query measure")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows.len(), ROW_COUNT, "measured row count");
        samples.push(start.elapsed().as_micros() as u64);
    }

    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95) / 100];
    println!("1000-row list: p50 = {}µs, p95 = {}µs", p50, p95);

    assert!(
        p50 < P50_THRESHOLD_US,
        "p50 {p50}µs exceeds {P50_THRESHOLD_US}µs (20ms) threshold"
    );

    println!("OK: M2 bench within budget.");
}
