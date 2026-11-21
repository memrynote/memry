//! Two connections opening one database at once, as the desktop app and the CLI
//! do: each migration applies exactly once and the counter only moves forward.

use std::path::Path;
use std::sync::{Arc, Barrier, OnceLock};
use std::thread;

use rusqlite::Connection;

use super::*;
use crate::storage::test_support::temp_dir;
use crate::storage::{Db, open_data};

const STEPS: u32 = 40;
const ROUNDS: usize = 10;

type Runner = fn(&mut Connection, &'static [Migration]) -> Result<u32, StorageError>;

/// Each migration records its version and the counter it ran under, so a body
/// that ran twice, or under a counter other than the one before it, shows.
fn counted() -> &'static [Migration] {
    static LIST: OnceLock<Vec<Migration>> = OnceLock::new();
    LIST.get_or_init(|| {
        (1..=STEPS)
            .map(|version| Migration {
                version,
                name: "counted",
                sql: format!(
                    "CREATE TABLE IF NOT EXISTS runs (version INTEGER NOT NULL, counter INTEGER NOT NULL);
                     INSERT INTO runs SELECT {version}, user_version FROM pragma_user_version;"
                )
                .leak(),
            })
            .collect()
    })
}

/// Runs `open` on two threads released together and returns both results.
fn race<T, F>(path: &Path, open: F) -> Vec<Result<T, StorageError>>
where
    T: Send + 'static,
    F: Fn(&Path) -> Result<T, StorageError> + Copy + Send + 'static,
{
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let path = path.to_owned();
            thread::spawn(move || {
                barrier.wait();
                open(&path)
            })
        })
        .collect();
    handles
        .into_iter()
        .map(|handle| handle.join().expect("opener panicked"))
        .collect()
}

fn race_counted(runner: Runner) {
    for round in 0..ROUNDS {
        let dir = temp_dir("migrate-race");
        let path = dir.path().join("data.db");
        let results = race(&path, move |path| {
            let db = Db::open(path)?;
            db.call_blocking(|conn| runner(conn, counted()))
        });
        for result in results {
            assert_eq!(
                result.expect("both openers migrate"),
                STEPS,
                "round {round}"
            );
        }

        let db = Db::open(&path).expect("reopen");
        let (version, runs) = db
            .call_blocking(|conn| {
                let runs = conn
                    .prepare("SELECT version, counter FROM runs ORDER BY rowid")
                    .and_then(|mut stmt| {
                        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                            .collect::<Result<Vec<(u32, u32)>, _>>()
                    })
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })?;
                Ok((user_version(conn)?, runs))
            })
            .expect("read back");
        let expected: Vec<(u32, u32)> = (1..=STEPS).map(|v| (v, v - 1)).collect();
        assert_eq!(
            runs, expected,
            "round {round}: each body once, counter one behind"
        );
        assert_eq!(version, STEPS, "round {round}");
    }
}

#[test]
fn run_applies_each_migration_once_when_two_connections_open_together() {
    race_counted(run);
}

#[test]
fn run_atomic_applies_each_migration_once_when_two_connections_open_together() {
    race_counted(|conn, migrations| run_atomic(conn, migrations).map_err(StorageError::from));
}

#[test]
fn two_opens_of_an_older_data_db_both_succeed() {
    for round in 0..ROUNDS {
        let dir = temp_dir("open-data-race");
        let path = dir.path().join("data.db");
        Db::open(&path)
            .and_then(|db| db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..12])))
            .expect("an older data.db");

        for result in race(&path, open_data) {
            result.unwrap_or_else(|err| panic!("round {round}: {err}"));
        }
        let version = open_data(&path)
            .and_then(|db| db.call_blocking(|conn| user_version(conn)))
            .expect("reopen");
        assert_eq!(version, latest_version(DATA_MIGRATIONS), "round {round}");
    }
}
