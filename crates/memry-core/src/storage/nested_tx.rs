//! A transaction that nests (#5231).
//!
//! SQLite has no nested `BEGIN`, so a write that opens its own transaction
//! cannot run inside a caller's. The bulk record apply commits a whole page
//! with its cursor in one transaction, and the merge, delete and outbox writes
//! it reaches open their own. So every core write opens one of these instead
//! of `unchecked_transaction`: a `BEGIN` on an autocommit connection, a
//! `SAVEPOINT` inside a caller's transaction. A raw `BEGIN` anywhere the apply
//! reaches would fail every page that hits it and wedge the device on its
//! cursor, which is why the test below holds the rule for the whole crate. Committing an inner one releases the
//! savepoint, and dropping it uncommitted rolls back to it, so an item that
//! fails leaves no half-written rows in the page and the page goes on.

use std::ops::Deref;

use rusqlite::Connection;

const SAVEPOINT: &str = "memry_nested";

/// An open transaction or savepoint; rolled back on drop unless committed.
pub struct NestedTx<'c> {
    conn: &'c Connection,
    savepoint: bool,
    open: bool,
}

/// Opens a transaction, or a savepoint when one is already open.
pub fn begin(conn: &Connection) -> rusqlite::Result<NestedTx<'_>> {
    let savepoint = !conn.is_autocommit();
    if savepoint {
        conn.execute_batch(&format!("SAVEPOINT {SAVEPOINT}"))?;
    } else {
        conn.execute_batch("BEGIN DEFERRED")?;
    }
    Ok(NestedTx {
        conn,
        savepoint,
        open: true,
    })
}

impl NestedTx<'_> {
    pub fn commit(mut self) -> rusqlite::Result<()> {
        self.open = false;
        if self.savepoint {
            self.conn.execute_batch(&format!("RELEASE {SAVEPOINT}"))
        } else {
            self.conn.execute_batch("COMMIT")
        }
    }

    fn rollback(&self) -> rusqlite::Result<()> {
        if self.savepoint {
            self.conn
                .execute_batch(&format!("ROLLBACK TO {SAVEPOINT}; RELEASE {SAVEPOINT}"))
        } else {
            self.conn.execute_batch("ROLLBACK")
        }
    }
}

impl Deref for NestedTx<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn
    }
}

impl Drop for NestedTx<'_> {
    fn drop(&mut self) {
        // SQLite may already have rolled the transaction back on its own (a
        // full disk, an interrupt); there is then nothing left to undo.
        if self.open && !self.conn.is_autocommit() {
            let _ = self.rollback();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .expect("count")
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("CREATE TABLE t (n INTEGER)")
            .expect("table");
        conn
    }

    #[test]
    fn an_inner_rollback_keeps_the_outer_writes() {
        let conn = setup();
        let outer = begin(&conn).expect("outer");
        outer.execute("INSERT INTO t VALUES (1)", []).expect("one");
        {
            let inner = begin(&outer).expect("inner");
            inner.execute("INSERT INTO t VALUES (2)", []).expect("two");
        }
        let inner = begin(&outer).expect("inner");
        inner
            .execute("INSERT INTO t VALUES (3)", [])
            .expect("three");
        inner.commit().expect("release");
        outer.commit().expect("commit");
        let kept: Vec<i64> = conn
            .prepare("SELECT n FROM t ORDER BY n")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(kept, [1, 3]);
    }

    /// The one file still on `unchecked_transaction` runs only in its own
    /// `Db::call`, never inside a page; the bulk body apply (#5231 part b)
    /// moves it.
    const RAW_TRANSACTION_ALLOWED: [&str; 2] = ["nested_tx.rs", "body_pull/log_writes.rs"];

    #[test]
    fn no_core_write_opens_a_transaction_that_cannot_nest() {
        fn scan(dir: &std::path::Path, offenders: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("read src") {
                let path = entry.expect("an entry").path();
                if path.is_dir() {
                    scan(&path, offenders);
                    continue;
                }
                let shown = path.to_string_lossy().replace('\\', "/");
                if path.extension().is_some_and(|ext| ext == "rs")
                    && !RAW_TRANSACTION_ALLOWED
                        .iter()
                        .any(|allowed| shown.ends_with(allowed))
                    && std::fs::read_to_string(&path)
                        .expect("read a source file")
                        .contains(".unchecked_transaction(")
                {
                    offenders.push(shown);
                }
            }
        }
        let mut offenders = Vec::new();
        scan(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut offenders,
        );
        assert!(
            offenders.is_empty(),
            "open transactions with storage::nested_tx::begin, which nests: {offenders:?}"
        );
    }

    #[test]
    fn an_outer_rollback_takes_released_inner_writes_with_it() {
        let conn = setup();
        {
            let outer = begin(&conn).expect("outer");
            let inner = begin(&outer).expect("inner");
            inner.execute("INSERT INTO t VALUES (1)", []).expect("one");
            inner.commit().expect("release");
        }
        assert!(conn.is_autocommit());
        assert_eq!(count(&conn), 0);
    }
}
