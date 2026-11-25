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
//!
//! The outermost one is `BEGIN IMMEDIATE`: it takes the database's write lock
//! before its first read, waiting out another connection's (the busy
//! timeout). A body write reads the log and appends the update it authored
//! from it, and the lock is what keeps a second connection, in this process
//! or another, from authoring over the same log in between (#5734). A
//! deferred transaction would instead fail its first write with
//! `SQLITE_BUSY` whenever another connection wrote since its read.

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
        conn.execute_batch("BEGIN IMMEDIATE")?;
    }
    Ok(NestedTx {
        conn,
        savepoint,
        open: true,
    })
}

impl NestedTx<'_> {
    /// A failed COMMIT or RELEASE leaves this open, so the drop rolls it back
    /// instead of leaving a dead transaction under every later write.
    pub fn commit(mut self) -> rusqlite::Result<()> {
        if self.savepoint {
            self.conn.execute_batch(&format!("RELEASE {SAVEPOINT}"))?;
        } else {
            self.conn.execute_batch("COMMIT")?;
        }
        self.open = false;
        Ok(())
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
        if !self.open {
            return;
        }
        // SQLite may already have rolled the transaction back on its own (a
        // full disk, an interrupt); there is then nothing left to undo, and
        // the caller sees the failure that caused it.
        if self.conn.is_autocommit() {
            eprintln!("memry-core: transaction already rolled back by SQLite when dropped");
            return;
        }
        let Err(error) = self.rollback() else {
            return;
        };
        if !self.savepoint {
            // Still open: `Db` rolls it back before the next call reaches the
            // connection.
            eprintln!("memry-core: rolling back a dropped transaction failed: {error}");
            return;
        }
        // The savepoint's rows would go out with the outer COMMIT. Rolling the
        // whole transaction back fails that COMMIT instead, so the page and
        // its cursor are retried and nothing half-written lands.
        eprintln!("memry-core: rolling back a dropped savepoint failed: {error}");
        if let Err(error) = self.conn.execute_batch("ROLLBACK") {
            eprintln!("memry-core: rolling back the savepoint's transaction failed: {error}");
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

    /// The migrations open with `Connection::transaction`, which takes
    /// `&mut Connection`, so nothing holding a page's shared `&Connection`
    /// can reach them, and they author no body.
    const RAW_TRANSACTION_ALLOWED: [&str; 2] = ["nested_tx.rs", "storage/migrations.rs"];

    /// rusqlite's two transaction openers, and a `BEGIN` statement with or
    /// without a mode. iCalendar's `BEGIN:` lines are not SQL.
    fn opens_raw_transaction(source: &str) -> bool {
        const OPENERS: [&str; 8] = [
            ".unchecked_transaction(",
            ".transaction()",
            "(\"BEGIN\"",
            "(\"BEGIN;",
            "(\"BEGIN ",
            "\"BEGIN DEFERRED",
            "\"BEGIN IMMEDIATE",
            "\"BEGIN EXCLUSIVE",
        ];
        OPENERS.iter().any(|opener| source.contains(opener))
    }

    #[test]
    fn no_core_write_opens_a_transaction_that_cannot_nest() {
        assert!(opens_raw_transaction(r#"conn.execute_batch("BEGIN")?"#));
        assert!(opens_raw_transaction("let tx = conn.transaction()?;"));
        assert!(!opens_raw_transaction(r#"format!("BEGIN:{}", name)"#));
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
                    && opens_raw_transaction(
                        &std::fs::read_to_string(&path).expect("read a source file"),
                    )
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

    fn rows(conn: &Connection) -> Vec<i64> {
        conn.prepare("SELECT n FROM t ORDER BY n")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    }

    #[test]
    fn probe_a_failed_commit_leaves_no_open_transaction() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE p (id INTEGER PRIMARY KEY);
             CREATE TABLE c (p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);",
        )
        .expect("schema");
        let txn = begin(&conn).expect("begin");
        txn.execute("INSERT INTO c VALUES (1)", []).expect("insert");
        assert!(txn.commit().is_err(), "the deferred key fails the COMMIT");
        assert!(conn.is_autocommit(), "a failed COMMIT is rolled back");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM c", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0);
    }

    /// Interrupts the next statement starting with `prefix` while it runs,
    /// which fails it. One slot per test: tests run in parallel.
    fn interrupt_next(
        slot: &std::sync::Mutex<Option<rusqlite::InterruptHandle>>,
        prefix: &str,
        event: rusqlite::trace::TraceEvent<'_>,
    ) {
        if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
            && sql.starts_with(prefix)
            && let Some(handle) = slot.lock().expect("the handle").take()
        {
            handle.interrupt();
        }
    }

    static INTERRUPT_RELEASE: std::sync::Mutex<Option<rusqlite::InterruptHandle>> =
        std::sync::Mutex::new(None);

    fn interrupt_release(event: rusqlite::trace::TraceEvent<'_>) {
        interrupt_next(&INTERRUPT_RELEASE, "RELEASE", event);
    }

    #[test]
    fn a_failed_release_rolls_the_savepoint_back() {
        let conn = setup();
        conn.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(interrupt_release),
        );
        let outer = begin(&conn).expect("outer");
        outer.execute("INSERT INTO t VALUES (1)", []).expect("one");
        let inner = begin(&outer).expect("inner");
        inner.execute("INSERT INTO t VALUES (2)", []).expect("two");
        *INTERRUPT_RELEASE.lock().expect("the handle") = Some(conn.get_interrupt_handle());
        assert!(inner.commit().is_err(), "the interrupted RELEASE fails");
        assert!(!conn.is_autocommit(), "the outer transaction stays open");
        outer.commit().expect("commit");
        conn.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
        assert_eq!(rows(&conn), [1], "the failed savepoint's write is gone");
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

    static INTERRUPT_ROLLBACK_TO: std::sync::Mutex<Option<rusqlite::InterruptHandle>> =
        std::sync::Mutex::new(None);

    fn interrupt_rollback_to(event: rusqlite::trace::TraceEvent<'_>) {
        interrupt_next(&INTERRUPT_ROLLBACK_TO, "ROLLBACK TO", event);
    }

    /// A savepoint whose rollback fails would leave its half-written rows for
    /// the outer COMMIT; the whole transaction goes instead, and the outer
    /// COMMIT fails, so the page and its cursor are retried.
    #[test]
    fn a_failed_savepoint_rollback_rolls_the_whole_transaction_back() {
        let conn = setup();
        conn.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(interrupt_rollback_to),
        );
        let outer = begin(&conn).expect("outer");
        outer.execute("INSERT INTO t VALUES (1)", []).expect("one");
        {
            let inner = begin(&outer).expect("inner");
            inner.execute("INSERT INTO t VALUES (2)", []).expect("two");
            *INTERRUPT_ROLLBACK_TO.lock().expect("the handle") = Some(conn.get_interrupt_handle());
        }
        assert!(conn.is_autocommit(), "the outer transaction is rolled back");
        assert!(outer.commit().is_err(), "the outer COMMIT fails");
        conn.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
        assert_eq!(rows(&conn), Vec::<i64>::new());
    }

    static INTERRUPT_ROLLBACK: std::sync::Mutex<Option<rusqlite::InterruptHandle>> =
        std::sync::Mutex::new(None);

    fn interrupt_rollback(event: rusqlite::trace::TraceEvent<'_>) {
        interrupt_next(&INTERRUPT_ROLLBACK, "ROLLBACK", event);
    }

    /// A dropped transaction whose ROLLBACK fails stays open on the shared
    /// connection. The next write's `begin` would see it, open a savepoint
    /// inside it, and its RELEASE would commit nothing: the next call rolls
    /// the dead transaction back before it runs.
    #[test]
    fn the_next_call_rolls_back_a_transaction_a_failed_drop_left_open() {
        let db = crate::storage::Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch("CREATE TABLE t (n INTEGER)")
                .expect("table");
            conn.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                Some(interrupt_rollback),
            );
            {
                let txn = begin(conn).expect("begin");
                txn.execute("INSERT INTO t VALUES (1)", []).expect("one");
                *INTERRUPT_ROLLBACK.lock().expect("the handle") = Some(conn.get_interrupt_handle());
            }
            conn.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
            assert!(!conn.is_autocommit(), "the failed ROLLBACK left it open");
            Ok(())
        })
        .expect("the failed drop");
        db.call_blocking(|conn| {
            assert!(conn.is_autocommit(), "no dead transaction reaches a call");
            let txn = begin(conn).expect("begin");
            txn.execute("INSERT INTO t VALUES (2)", []).expect("two");
            txn.commit().expect("commit");
            assert!(conn.is_autocommit(), "the write committed");
            assert_eq!(rows(conn), [2]);
            Ok(())
        })
        .expect("the next call");
    }
}
