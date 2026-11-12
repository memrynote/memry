//! The search sheet's recently opened results (#4322), desktop's
//! `search_reasons`.
//!
//! Device-local UI state in `data.db` (migration 0017): never synced, never
//! logged, gone with the vault on sign-out. A recent names an item, so it can
//! outlive it: [`list`] checks every row against `data.db` the way a search
//! hit is checked, and skips an item deleted since it was opened.

use rusqlite::{Connection, params};

use super::{HitKind, SearchHit, failed, is_live, note_kind};
use crate::api::errors::StorageError;

/// How many recents a vault keeps, newest first.
pub const RECENTS_CAP: u32 = 10;

/// One opened result and the query that found it.
#[derive(Debug, Clone, PartialEq)]
pub struct Recent {
    /// Shaped like a hit, with a score of zero, so a shell opens it through
    /// the route it opens a hit through.
    pub hit: SearchHit,
    pub query: String,
    /// Epoch milliseconds.
    pub visited_at: i64,
}

/// Records that `hit` was opened from a search for `query`.
///
/// Reopening an item replaces its row, so it moves to the top with the newer
/// query rather than appearing twice. The stamp is kept above every stored
/// one, so two opens in one millisecond still list newest first. The oldest
/// rows past [`RECENTS_CAP`] are dropped.
pub fn record(
    data: &Connection,
    hit: &SearchHit,
    query: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let item_type = match hit.kind {
        HitKind::Note => "note",
        HitKind::Journal { .. } => "journal",
        HitKind::Task => "task",
    };
    data.execute(
        "INSERT INTO search_recents (item_type, item_id, title, query, visited_at)
         VALUES (?1, ?2, ?3, ?4,
                 max(?5, COALESCE((SELECT max(visited_at) + 1 FROM search_recents), ?5)))
         ON CONFLICT (item_type, item_id) DO UPDATE SET
           title = excluded.title, query = excluded.query, visited_at = excluded.visited_at",
        params![item_type, hit.id, hit.title, query, now_ms],
    )
    .map_err(failed)?;
    data.execute(
        "DELETE FROM search_recents WHERE rowid NOT IN (
           SELECT rowid FROM search_recents ORDER BY visited_at DESC, item_id LIMIT ?1)",
        params![RECENTS_CAP],
    )
    .map_err(failed)?;
    Ok(())
}

/// The recents whose items are still live, newest first.
pub fn list(data: &Connection) -> Result<Vec<Recent>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT item_type, item_id, title, query, visited_at FROM search_recents
             ORDER BY visited_at DESC, item_id LIMIT ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![RECENTS_CAP], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    let mut recents = Vec::new();
    for (item_type, id, title, query, visited_at) in rows {
        let kind = if item_type == "task" {
            is_live(data, "task", &id)?.then_some(HitKind::Task)
        } else {
            note_kind(data, &id)?
        };
        let Some(kind) = kind else {
            continue;
        };
        recents.push(Recent {
            hit: SearchHit {
                id,
                title,
                kind,
                score: 0.0,
            },
            query,
            visited_at,
        });
    }
    Ok(recents)
}

/// Forgets every recent.
pub fn clear(data: &Connection) -> Result<(), StorageError> {
    data.execute("DELETE FROM search_recents", [])
        .map_err(failed)
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;
    use crate::storage::migrations::{DATA_MIGRATIONS, run};

    fn migrated() -> Db {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("migrate");
        db
    }

    fn live(conn: &Connection, item_type: &str, id: &str) {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
             VALUES (?1, ?2, '{}', 'full', 1)",
            params![item_type, id],
        )
        .expect("insert");
    }

    fn hit(kind: HitKind, id: &str) -> SearchHit {
        SearchHit {
            id: id.to_owned(),
            title: format!("title {id}"),
            kind,
            score: -1.5,
        }
    }

    fn listed(conn: &Connection) -> Vec<(String, String, i64)> {
        list(conn)
            .expect("list")
            .into_iter()
            .map(|recent| (recent.hit.id, recent.query, recent.visited_at))
            .collect()
    }

    #[test]
    fn a_recorded_hit_lists_with_its_query_and_routes_like_a_hit() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "note", "n1");
                live(conn, "journal", "j1");
                conn.execute(
                    "INSERT INTO journal_entries (id, date) VALUES ('j1', '2026-01-14')",
                    [],
                )
                .map_err(failed)?;
                live(conn, "task", "t1");
                record(conn, &hit(HitKind::Note, "n1"), "alpha", 1)?;
                let journal = HitKind::Journal {
                    date: "2026-01-14".to_owned(),
                };
                record(conn, &hit(journal.clone(), "j1"), "beta", 2)?;
                record(conn, &hit(HitKind::Task, "t1"), "gamma", 3)?;

                let recents = list(conn)?;
                let kinds: Vec<_> = recents.iter().map(|r| r.hit.kind.clone()).collect();
                assert_eq!(kinds, [HitKind::Task, journal, HitKind::Note]);
                assert_eq!(recents[2].hit.title, "title n1");
                assert_eq!(recents[2].query, "alpha");
                Ok(())
            })
            .expect("recents");
    }

    #[test]
    fn reopening_an_item_moves_it_to_the_top_with_the_newer_query() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "note", "n1");
                live(conn, "note", "n2");
                record(conn, &hit(HitKind::Note, "n1"), "first", 1)?;
                record(conn, &hit(HitKind::Note, "n2"), "other", 2)?;
                record(conn, &hit(HitKind::Note, "n1"), "second", 3)?;
                assert_eq!(
                    listed(conn),
                    [
                        ("n1".to_owned(), "second".to_owned(), 3),
                        ("n2".to_owned(), "other".to_owned(), 2),
                    ]
                );
                Ok(())
            })
            .expect("recents");
    }

    #[test]
    fn two_opens_in_one_millisecond_list_newest_first() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "note", "n1");
                live(conn, "note", "n2");
                record(conn, &hit(HitKind::Note, "n1"), "q", 7)?;
                record(conn, &hit(HitKind::Note, "n2"), "q", 7)?;
                let ids: Vec<_> = listed(conn).into_iter().map(|(id, _, _)| id).collect();
                assert_eq!(ids, ["n2", "n1"]);
                Ok(())
            })
            .expect("recents");
    }

    #[test]
    fn only_the_ten_newest_are_kept() {
        migrated()
            .call_blocking(|conn| {
                for index in 0..12 {
                    let id = format!("n{index:02}");
                    live(conn, "note", &id);
                    record(conn, &hit(HitKind::Note, &id), "q", index)?;
                }
                let count: i64 = conn
                    .query_row("SELECT count(*) FROM search_recents", [], |row| row.get(0))
                    .map_err(failed)?;
                assert_eq!(count, 10);
                let ids: Vec<_> = listed(conn).into_iter().map(|(id, _, _)| id).collect();
                let expected: Vec<_> = (2..12).rev().map(|index| format!("n{index:02}")).collect();
                assert_eq!(ids, expected);
                Ok(())
            })
            .expect("recents");
    }

    #[test]
    fn clear_forgets_every_recent() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "note", "n1");
                record(conn, &hit(HitKind::Note, "n1"), "q", 1)?;
                clear(conn)?;
                assert!(list(conn)?.is_empty());
                Ok(())
            })
            .expect("recents");
    }

    #[test]
    fn an_item_deleted_since_it_was_opened_is_skipped() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "note", "n1");
                live(conn, "task", "t1");
                record(conn, &hit(HitKind::Note, "n1"), "q", 1)?;
                record(conn, &hit(HitKind::Task, "t1"), "q", 2)?;
                record(conn, &hit(HitKind::Note, "never-synced"), "q", 3)?;
                conn.execute(
                    "UPDATE sync_items SET deleted_at = 5 WHERE item_id = 't1'",
                    [],
                )
                .map_err(failed)?;
                assert_eq!(listed(conn), [("n1".to_owned(), "q".to_owned(), 1)]);
                Ok(())
            })
            .expect("recents");
    }

    /// 0017 adds the table to a `data.db` an older build wrote, leaving its
    /// rows alone, and recents work on it straight away.
    #[test]
    fn an_older_data_database_gains_an_empty_recents_table() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..16])?;
            live(conn, "note", "n1");
            assert_eq!(run(conn, DATA_MIGRATIONS)?, 17);
            assert!(list(conn)?.is_empty());
            record(conn, &hit(HitKind::Note, "n1"), "q", 1)?;
            assert_eq!(listed(conn), [("n1".to_owned(), "q".to_owned(), 1)]);
            Ok(())
        })
        .expect("migrate");
    }
}
