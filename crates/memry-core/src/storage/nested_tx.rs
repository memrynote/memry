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

    /// The functions that may open a raw transaction, as (file, header).
    /// Only that function's body is exempt, so a new opener elsewhere in the
    /// same file still fails (#5423 C5: a whole-file entry for `recovery.rs`
    /// would have hidden its production salvage's `.transaction()`).
    ///
    /// The `&mut Connection` openers (`update_log.rs`, `compact.rs`,
    /// `migrations.rs`, `legacy_numbering.rs`) cannot be reached from a page's
    /// shared `&Connection`. The tests hold a lock or leave a transaction open
    /// on a second connection on purpose. `begin` is the one nesting opener.
    const RAW_TRANSACTION_ALLOWED: [(&str, &str); 15] = [
        // First: the test module holds these headers as text.
        ("storage/nested_tx.rs", "#[cfg(test)]\nmod tests"),
        ("storage/nested_tx.rs", "pub fn begin("),
        ("crdt/update_log.rs", "pub fn append_local_update("),
        ("crdt/update_log.rs", "pub fn purge("),
        ("crdt/compact.rs", "pub fn fold_compacted("),
        ("storage/migrations.rs", "pub fn run_atomic("),
        (
            "storage/migrations/legacy_numbering.rs",
            "pub(super) fn renumber(",
        ),
        (
            "storage/connection.rs",
            "fn a_reader_never_sees_an_uncommitted_write_and_does_not_wait_for_it(",
        ),
        (
            "storage/guard.rs",
            "fn drizzle_guard_fails_closed_when_the_file_is_locked(",
        ),
        (
            "storage/pool.rs",
            "fn a_reader_that_left_a_transaction_open_is_rolled_back_on_return(",
        ),
        (
            "storage/recovery.rs",
            "fn a_locked_database_is_an_error_not_a_pending_recovery(",
        ),
        (
            "storage/index_db_tests.rs",
            "fn an_index_held_by_another_connection_is_an_error_and_keeps_its_rows(",
        ),
        (
            "storage/vec_tests.rs",
            "fn a_locked_index_is_busy_not_a_vec_defect(",
        ),
        (
            "domain/agent_records_tests.rs",
            "fn sealing_with_nothing_pending_or_held_opens_no_write_transaction(",
        ),
        (
            "storage/migrations/canvases_tests.rs",
            "fn a_crash_at_any_step_converges_on_the_next_open(",
        ),
    ];

    /// rusqlite's transaction openers and a SQL `BEGIN`, in any case and
    /// spacing: the source is lowercased with its whitespace removed, so a
    /// call split over lines or a `begin` in lowercase still counts.
    /// iCalendar's `BEGIN:` lines and `.expect("begin")` messages are not SQL.
    fn opens_raw_transaction(source: &str) -> bool {
        let code: String = source
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase();
        const CALLS: [&str; 3] = [
            ".unchecked_transaction(",
            ".transaction(",
            ".transaction_with_behavior(",
        ];
        const MODES: [&str; 4] = ["deferred", "immediate", "exclusive", "transaction"];
        let constructor = code
            .match_indices("transaction::new")
            .any(|(at, _)| !code[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_'));
        // A statement starts after a quote or after a `;` in a batch.
        let sql_begin = code.match_indices("begin").any(|(at, _)| {
            let rest = &code[at + "begin".len()..];
            let ends = rest.starts_with('"') || rest.starts_with(';');
            if code[..at].ends_with(';') {
                return ends || MODES.iter().any(|mode| rest.starts_with(mode));
            }
            let Some(call) = code[..at].strip_suffix('"') else {
                return false;
            };
            let call = call.trim_end_matches(['r', '#']);
            MODES.iter().any(|mode| rest.starts_with(mode))
                || (ends && call.ends_with('(') && !call.ends_with(".expect("))
        });
        constructor || sql_begin || CALLS.iter().any(|call| code.contains(call))
    }

    /// `source` without the item that starts at `header`, through its closing
    /// brace. Panics unless the header occurs once and its body opens a raw
    /// transaction, so a stale or ambiguous entry fails instead of hiding code.
    fn without_item(source: &str, shown: &str, header: &str) -> String {
        assert_eq!(
            source.matches(header).count(),
            1,
            "{shown}: allowlisted `{header}` must occur exactly once"
        );
        let start = source.find(header).expect("the header");
        let open = start + source[start..].find('{').expect("the body");
        let mut depth = 0usize;
        let mut end = None;
        let bytes = source.as_bytes();
        for (offset, ch) in source[open..].char_indices() {
            let at = open + offset;
            // A `'{'` char literal is not a brace of the item.
            if bytes.get(at.wrapping_sub(1)) == Some(&b'\'') && bytes.get(at + 1) == Some(&b'\'') {
                continue;
            }
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + offset + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.unwrap_or_else(|| panic!("{shown}: `{header}` has no closing brace"));
        assert!(
            opens_raw_transaction(&source[start..end]),
            "{shown}: allowlisted `{header}` opens no raw transaction; drop the entry"
        );
        format!("{}{}", &source[..start], &source[end..])
    }

    fn raw_transaction_offenders(root: &std::path::Path) -> Vec<String> {
        fn scan(dir: &std::path::Path, root: &std::path::Path, offenders: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("read src") {
                let path = entry.expect("an entry").path();
                if path.is_dir() {
                    scan(&path, root, offenders);
                    continue;
                }
                if path.extension().is_none_or(|ext| ext != "rs") {
                    continue;
                }
                let shown = path
                    .strip_prefix(root)
                    .expect("under src")
                    .to_string_lossy()
                    .replace('\\', "/");
                // A Windows checkout has CRLF; the matchers and the
                // multi-line headers above are written for LF.
                let mut source = std::fs::read_to_string(&path)
                    .expect("read a source file")
                    .replace("\r\n", "\n");
                for (_, header) in RAW_TRANSACTION_ALLOWED
                    .iter()
                    .filter(|(file, _)| *file == shown)
                {
                    source = without_item(&source, &shown, header);
                }
                if opens_raw_transaction(&source) {
                    offenders.push(shown);
                }
            }
        }
        let mut offenders = Vec::new();
        scan(root, root, &mut offenders);
        offenders
    }

    #[test]
    fn the_guard_sees_every_raw_opener() {
        for opener in [
            r#"conn.execute_batch("BEGIN")?"#,
            r#"conn.execute_batch("begin;")?"#,
            r#"conn.execute_batch(r"BEGIN")?"#,
            r#"conn.execute_batch("begin immediate")?"#,
            r#"const SQL: &str = "Begin Exclusive";"#,
            "conn.execute_batch(\"CREATE TABLE t (n);\n BEGIN EXCLUSIVE;\")",
            "let tx = conn.transaction()?;",
            "let tx = conn\n    .transaction ()?;",
            "conn.unchecked_transaction()?",
            "conn.transaction_with_behavior(TransactionBehavior::Immediate)",
            "Transaction::new(&mut conn, TransactionBehavior::Deferred)?",
            "rusqlite::Transaction::new_unchecked(&conn, TransactionBehavior::Deferred)?",
        ] {
            assert!(opens_raw_transaction(opener), "missed: {opener}");
        }
        for not_sql in [
            r#"format!("BEGIN:{}", name)"#,
            r#""BEGIN" if stack.len() >= MAX_DEPTH => {}"#,
            r#"nested_tx::begin(conn).expect("begin")"#,
            "CalendarTransaction::new(x)",
        ] {
            assert!(!opens_raw_transaction(not_sql), "flagged: {not_sql}");
        }
    }

    /// A raw opener outside an allowlisted function of an allowlisted file
    /// still fails: the salvage `recovery.rs` shipped before #5339.
    #[test]
    fn an_allowlisted_file_is_exempt_only_inside_its_function() {
        let dir = tempfile::Builder::new()
            .prefix("nested-tx-guard")
            .tempdir()
            .expect("dir");
        std::fs::create_dir_all(dir.path().join("storage")).expect("storage dir");
        std::fs::write(
            dir.path().join("storage/recovery.rs"),
            "fn salvage_in_transaction(fresh: &mut Connection) {\n    let tx = fresh\n        .transaction()\n        .map_err(failed)?;\n}\n\
             mod tests {\n    fn a_locked_database_is_an_error_not_a_pending_recovery() {\n        holder.execute_batch(\"BEGIN EXCLUSIVE;\");\n    }\n}\n",
        )
        .expect("write");
        assert_eq!(
            raw_transaction_offenders(dir.path()),
            ["storage/recovery.rs"]
        );
    }

    /// A CRLF checkout (Windows) gets the verdicts an LF one gets: the
    /// multi-line `#[cfg(test)]\nmod tests` header still matches and an
    /// opener outside the allowlisted function still fails.
    #[test]
    fn a_crlf_checkout_gets_the_verdicts_of_an_lf_one() {
        let files = [
            (
                "storage/nested_tx.rs",
                "pub fn begin(conn: &Connection) {\n    conn.transaction_with_behavior(Immediate)\n}\n\
                 #[cfg(test)]\nmod tests {\n    fn t() {\n        conn.execute_batch(\"BEGIN\");\n    }\n}\n",
            ),
            (
                "storage/recovery.rs",
                "fn salvage(fresh: &mut Connection) {\n    let tx = fresh\n        .transaction()?;\n}\n\
                 mod tests {\n    fn a_locked_database_is_an_error_not_a_pending_recovery() {\n        holder.execute_batch(\"BEGIN EXCLUSIVE;\");\n    }\n}\n",
            ),
        ];
        let verdict = |eol: &str| {
            let dir = tempfile::Builder::new()
                .prefix("nested-tx-eol")
                .tempdir()
                .expect("dir");
            std::fs::create_dir_all(dir.path().join("storage")).expect("storage dir");
            for (file, source) in files {
                std::fs::write(dir.path().join(file), source.replace('\n', eol)).expect("write");
            }
            raw_transaction_offenders(dir.path())
        };
        assert_eq!(verdict("\n"), ["storage/recovery.rs"]);
        assert_eq!(verdict("\r\n"), ["storage/recovery.rs"]);
    }

    #[test]
    fn no_core_write_opens_a_transaction_that_cannot_nest() {
        let offenders = raw_transaction_offenders(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
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
