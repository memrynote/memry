//! The search sheet's recently opened results (#4322), desktop's
//! `search_reasons`.
//!
//! Device-local UI state in `data.db` (migrations 0017 and 0035): never
//! synced, never logged, gone with the vault on sign-out. A recent names an
//! item, so it can outlive it: [`list`] checks every row against `data.db` the
//! way a search hit is checked, and skips an item deleted since it was opened.
//!
//! How many recents a vault keeps is the caller's: iOS keeps 10, desktop 20
//! (Electron's `search-handlers.ts:242`). The table is device-local, so the
//! two never trim each other's rows.

use rusqlite::{Connection, params};

use super::{HitKind, MatchKind, SearchHit, failed, is_live, note_kind};
use crate::api::errors::StorageError;
use crate::storage::nested_tx;

/// One opened result and the query that found it.
#[derive(Debug, Clone, PartialEq)]
pub struct Recent {
    /// Shaped like a hit, with a score of zero, so a shell opens it through
    /// the route it opens a hit through.
    pub hit: SearchHit,
    pub query: String,
    /// The icon the shell recorded with it (Electron's `itemIcon`), if any.
    pub icon: Option<String>,
    /// Epoch milliseconds.
    pub visited_at: i64,
}

/// Records that `hit` was opened from a search for `query`, with the `icon`
/// the shell shows for it.
///
/// Reopening an item replaces its row and its icon, so it moves to the top
/// with the newer query rather than appearing twice. The stamp is kept above
/// every stored one, so two opens in one millisecond still list newest first.
/// The oldest rows past `cap` are dropped, with their icons.
pub fn record(
    data: &Connection,
    hit: &SearchHit,
    query: &str,
    icon: Option<&str>,
    cap: u32,
    now_ms: i64,
) -> Result<(), StorageError> {
    let item_type = match hit.kind {
        HitKind::Note { .. } => "note",
        HitKind::Journal { .. } => "journal",
        HitKind::Task => "task",
        HitKind::Inbox => "inbox",
    };
    let tx = nested_tx::begin(data).map_err(failed)?;
    tx.execute(
        "INSERT INTO search_recents (item_type, item_id, title, query, visited_at)
         VALUES (?1, ?2, ?3, ?4,
                 max(?5, COALESCE((SELECT max(visited_at) + 1 FROM search_recents), ?5)))
         ON CONFLICT (item_type, item_id) DO UPDATE SET
           title = excluded.title, query = excluded.query, visited_at = excluded.visited_at",
        params![item_type, hit.id, hit.title, query, now_ms],
    )
    .map_err(failed)?;
    match icon.filter(|icon| !icon.is_empty()) {
        Some(icon) => tx.execute(
            "INSERT INTO search_recent_icons (item_type, item_id, icon, recorded_at)
             SELECT ?1, ?2, ?3, visited_at FROM search_recents
              WHERE item_type = ?1 AND item_id = ?2
             ON CONFLICT (item_type, item_id) DO UPDATE SET
               icon = excluded.icon, recorded_at = excluded.recorded_at",
            params![item_type, hit.id, icon],
        ),
        None => tx.execute(
            "DELETE FROM search_recent_icons WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, hit.id],
        ),
    }
    .map_err(failed)?;
    tx.execute(
        "DELETE FROM search_recents WHERE rowid NOT IN (
           SELECT rowid FROM search_recents ORDER BY visited_at DESC, item_id LIMIT ?1)",
        params![cap],
    )
    .map_err(failed)?;
    tx.execute(
        "DELETE FROM search_recent_icons WHERE NOT EXISTS (
           SELECT 1 FROM search_recents r
            WHERE r.item_type = search_recent_icons.item_type
              AND r.item_id = search_recent_icons.item_id)",
        [],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)
}

/// The recents whose items are still live, newest first, at most `cap`.
///
/// An icon lists only with the visit it was recorded with: a build that
/// predates icons moves `visited_at` on reopen and leaves the old icon.
///
/// [`record`] trims the table to its cap, dead or live, and this drops the
/// dead ones after reading them. A deleted item therefore keeps its slot
/// until newer opens push it out, and the list can hold fewer than `cap`
/// recents.
pub fn list(data: &Connection, cap: u32) -> Result<Vec<Recent>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT r.item_type, r.item_id, r.title, r.query, r.visited_at, i.icon
               FROM search_recents r
               LEFT JOIN search_recent_icons i
                 ON i.item_type = r.item_type AND i.item_id = r.item_id
                AND i.recorded_at = r.visited_at
             ORDER BY r.visited_at DESC, r.item_id LIMIT ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![cap], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    let mut recents = Vec::new();
    for (item_type, id, title, query, visited_at, icon) in rows {
        let kind = match item_type.as_str() {
            "task" => is_live(data, "task", &id)?.then_some(HitKind::Task),
            "inbox" => is_live(data, "inbox", &id)?.then_some(HitKind::Inbox),
            _ => note_kind(data, &id)?,
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
                snippet: Vec::new(),
                match_kind: MatchKind::Body,
                matched_name: None,
            },
            query,
            icon,
            visited_at,
        });
    }
    Ok(recents)
}

/// Forgets every recent.
pub fn clear(data: &Connection) -> Result<(), StorageError> {
    let tx = nested_tx::begin(data).map_err(failed)?;
    tx.execute("DELETE FROM search_recents", [])
        .map_err(failed)?;
    tx.execute("DELETE FROM search_recent_icons", [])
        .map_err(failed)?;
    tx.commit().map_err(failed)
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

    const TEN: u32 = 10;

    const NOTE: HitKind = HitKind::Note {
        emoji: None,
        folder_path: None,
    };

    fn hit(kind: HitKind, id: &str) -> SearchHit {
        SearchHit {
            id: id.to_owned(),
            title: format!("title {id}"),
            kind,
            score: -1.5,
            snippet: Vec::new(),
            match_kind: MatchKind::Body,
            matched_name: None,
        }
    }

    fn listed(conn: &Connection) -> Vec<(String, String, i64)> {
        list(conn, TEN)
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
                record(conn, &hit(NOTE, "n1"), "alpha", None, TEN, 1)?;
                let journal = HitKind::Journal {
                    date: "2026-01-14".to_owned(),
                };
                record(conn, &hit(journal.clone(), "j1"), "beta", None, TEN, 2)?;
                record(conn, &hit(HitKind::Task, "t1"), "gamma", None, TEN, 3)?;

                let recents = list(conn, TEN)?;
                let kinds: Vec<_> = recents.iter().map(|r| r.hit.kind.clone()).collect();
                assert_eq!(kinds, [HitKind::Task, journal, NOTE]);
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
                record(conn, &hit(NOTE, "n1"), "first", None, TEN, 1)?;
                record(conn, &hit(NOTE, "n2"), "other", None, TEN, 2)?;
                record(conn, &hit(NOTE, "n1"), "second", None, TEN, 3)?;
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
                record(conn, &hit(NOTE, "n1"), "q", None, TEN, 7)?;
                record(conn, &hit(NOTE, "n2"), "q", None, TEN, 7)?;
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
                    record(conn, &hit(NOTE, &id), "q", None, TEN, index)?;
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
                record(conn, &hit(NOTE, "n1"), "q", None, TEN, 1)?;
                clear(conn)?;
                assert!(list(conn, TEN)?.is_empty());
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
                record(conn, &hit(NOTE, "n1"), "q", None, TEN, 1)?;
                record(conn, &hit(HitKind::Task, "t1"), "q", None, TEN, 2)?;
                record(conn, &hit(NOTE, "never-synced"), "q", None, TEN, 3)?;
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

    /// 0017 and 0035 add the tables to a `data.db` an older build wrote,
    /// leaving its rows alone, and recents work on it straight away.
    #[test]
    fn an_older_data_database_gains_an_empty_recents_table() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..16])?;
            live(conn, "note", "n1");
            let latest = DATA_MIGRATIONS.last().expect("migrations").version;
            assert_eq!(run(conn, DATA_MIGRATIONS)?, latest);
            assert!(list(conn, TEN)?.is_empty());
            record(conn, &hit(NOTE, "n1"), "q", None, TEN, 1)?;
            assert_eq!(listed(conn), [("n1".to_owned(), "q".to_owned(), 1)]);
            Ok(())
        })
        .expect("migrate");
    }

    /// The cap is the caller's: desktop keeps Electron's 20, iOS 10, over
    /// the same table.
    #[test]
    fn each_caller_keeps_its_own_cap() {
        migrated()
            .call_blocking(|conn| {
                for index in 0..25 {
                    let id = format!("n{index:02}");
                    live(conn, "note", &id);
                    record(conn, &hit(NOTE, &id), "q", None, 20, index)?;
                }
                assert_eq!(list(conn, 20)?.len(), 20);
                assert_eq!(list(conn, TEN)?.len(), 10);
                assert_eq!(listed(conn)[0].0, "n24");
                Ok(())
            })
            .expect("recents");
    }

    fn icons(conn: &Connection) -> Vec<(String, Option<String>)> {
        list(conn, 20)
            .expect("list")
            .into_iter()
            .map(|recent| (recent.hit.id, recent.icon))
            .collect()
    }

    #[test]
    fn an_icon_is_kept_with_its_recent_and_replaced_on_reopen() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "task", "t1");
                live(conn, "note", "n1");
                record(
                    conn,
                    &hit(HitKind::Task, "t1"),
                    "q",
                    Some("icon:check"),
                    20,
                    1,
                )?;
                record(conn, &hit(NOTE, "n1"), "q", Some(""), 20, 2)?;
                assert_eq!(
                    icons(conn),
                    [
                        ("n1".to_owned(), None),
                        ("t1".to_owned(), Some("icon:check".to_owned())),
                    ]
                );
                record(conn, &hit(HitKind::Task, "t1"), "q", None, 20, 3)?;
                assert_eq!(icons(conn)[0], ("t1".to_owned(), None));
                Ok(())
            })
            .expect("recents");
    }

    /// An older build reopens the item with 0017's upsert and never touches
    /// the icon, so the icon of the earlier visit must not come back.
    #[test]
    fn an_icon_an_older_build_left_behind_is_not_listed() {
        migrated()
            .call_blocking(|conn| {
                live(conn, "task", "t1");
                record(conn, &hit(HitKind::Task, "t1"), "q", Some("✅"), 20, 1)?;
                conn.execute(
                    "INSERT INTO search_recents (item_type, item_id, title, query, visited_at)
                     VALUES ('task', 't1', 'title t1', 'older', 2)
                     ON CONFLICT (item_type, item_id) DO UPDATE SET
                       title = excluded.title, query = excluded.query,
                       visited_at = excluded.visited_at",
                    [],
                )
                .map_err(failed)?;
                assert_eq!(icons(conn), [("t1".to_owned(), None)]);
                record(conn, &hit(HitKind::Task, "t1"), "q", Some("✅"), 20, 3)?;
                assert_eq!(icons(conn), [("t1".to_owned(), Some("✅".to_owned()))]);
                Ok(())
            })
            .expect("recents");
    }

    fn icon_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM search_recent_icons", [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    #[test]
    fn a_trimmed_or_cleared_recent_takes_its_icon_with_it() {
        migrated()
            .call_blocking(|conn| {
                for index in 0..3 {
                    let id = format!("n{index}");
                    live(conn, "note", &id);
                    record(conn, &hit(NOTE, &id), "q", Some("🌱"), 2, index)?;
                }
                assert_eq!(icon_rows(conn), 2);
                clear(conn)?;
                assert_eq!(icon_rows(conn), 0);
                Ok(())
            })
            .expect("recents");
    }
}
