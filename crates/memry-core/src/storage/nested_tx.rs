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
        } else if let Err(error) = self.rollback() {
            eprintln!(
                "memry-core: rolling back a dropped {} failed: {error}",
                if self.savepoint {
                    "savepoint"
                } else {
                    "transaction"
                }
            );
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

    /// These two open with `Connection::transaction`, which takes
    /// `&mut Connection`, so nothing holding a page's shared `&Connection`
    /// can reach them.
    ///
    /// The `*_tests.rs` files and the test modules of `connection.rs`,
    /// `guard.rs`, `pool.rs` and `recovery.rs` (desktop, feat/tauri-v2) hold
    /// a lock or leave a transaction open on a second connection on purpose.
    const RAW_TRANSACTION_ALLOWED: [&str; 11] = [
        "nested_tx.rs",
        "crdt/update_log.rs",
        "storage/migrations.rs",
        "storage/connection.rs",
        "storage/guard.rs",
        "storage/pool.rs",
        "storage/recovery.rs",
        "storage/index_db_tests.rs",
        "storage/vec_tests.rs",
        "domain/agent_records_tests.rs",
        "storage/migrations/canvases_tests.rs",
    ];

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

    static INTERRUPT_RELEASE: std::sync::Mutex<Option<rusqlite::InterruptHandle>> =
        std::sync::Mutex::new(None);

    /// Interrupts the next `RELEASE` while it runs, which fails it.
    fn interrupt_release(event: rusqlite::trace::TraceEvent<'_>) {
        if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
            && sql.starts_with("RELEASE")
            && let Some(handle) = INTERRUPT_RELEASE.lock().expect("the handle").take()
        {
            handle.interrupt();
        }
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
}
