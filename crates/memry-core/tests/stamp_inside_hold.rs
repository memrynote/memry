//! Every stamp a `data.db` writer closure writes is taken inside that closure
//! (#5849).
//!
//! The incremental search reindex reads rows stamped at or after its watermark.
//! A stamp taken before the writer is held (before an `.await`, an HTTP round,
//! or the wait for the lock) can commit below a watermark a reindex wrote
//! meanwhile, and the row is never indexed. So a writer closure (`|conn| ...`,
//! `|txn| ...`, `|tx| ...`) in the sync, CRDT and editor code may not capture a
//! stamp-named binding from outside: it reads the clock itself.
//!
//! [`ALLOWED`] names the closures that capture one on purpose. Each writes no
//! search input (`notes`/`journal_entries`/`tasks.synced_at`,
//! `yjs_updates.created_at`, `yjs_snapshots.compacted_at`), so its stamp may be
//! older than the hold. A new entry needs the same reason.

use std::path::{Path, PathBuf};

/// The source the rule covers, relative to the crate root.
const SCANNED: &[&str] = &["src/sync", "src/api/sync", "src/crdt", "src/api/editor.rs"];

/// Bindings that hold a clock reading.
const STAMPS: &[&str] = &[
    "now",
    "now_ms",
    "at",
    "created_at",
    "compacted_at",
    "updated_at",
    "stamp",
];

/// `file::fn::binding` of a closure that captures a stamp on purpose.
const ALLOWED: &[&str] = &[
    // The resident documents' idle clock, in memory: no row is stamped.
    "src/api/editor.rs::open::now",
    "src/api/editor.rs::with_document::now",
    // Attachment, upload-queue, outbox, retry, ledger and body-state stamps.
    "src/api/sync/attachment_fetch.rs::fetch_with_manifest::now",
    "src/api/sync/note_uploads.rs::queue_note_attachment::now",
    "src/sync/driver/progress.rs::seed::now",
    "src/sync/driver/snapshots.rs::record_stored::now",
    "src/sync/hardening/manifest.rs::run::now_ms",
    "src/sync/pull/items.rs::record_corrupt::now",
    "src/sync/push.rs::drain_wave::now",
    "src/sync/push.rs::pending::now",
    "src/sync/push.rs::push_records::at",
    "src/sync/push/crdt.rs::push_as_snapshot::at",
    "src/sync/push/crdt.rs::push_as_snapshot::now",
    "src/sync/push/crdt.rs::mark::at",
    "src/sync/push/settle.rs::defer_unsettled::at",
    "src/sync/push/settle.rs::held_for_unknown_signer::at",
    // A body's `crdt:` cursor.
    "src/sync/body_pull/log_writes.rs::hold_empty_body::now",
    // Feed-restart and first-sync-completed meta.
    "src/sync/first_sync.rs::passes::now_ms",
    // A parameter its caller reads inside its own hold: `orphans.rs` `run`
    // (`tombstone_orphans`), `PullLoop::apply_all` and the task writers
    // (`join_after_apply`).
    "src/sync/hardening/orphans.rs::tombstone_orphans::now_ms",
    "src/sync/versioned_apply.rs::join_after_apply::now_ms",
];

#[test]
fn a_crlf_checkout_still_skips_the_inline_test_module() {
    let source = "fn write(db: &Db) {\n    db.with(|conn| {\n        let now = now_ms();\n        save(conn, now)\n    });\n}\n\n#[cfg(test)]\nmod tests {\n    fn kept_row() {\n        let now = now_ms();\n        db.with(|conn| save(conn, now));\n    }\n}\n";
    assert_eq!(
        captured_stamps(source),
        [("kept_row".to_owned(), "now".to_owned())]
    );
    assert_eq!(scan(&source.replace('\n', "\r\n")), []);
}

#[test]
fn no_writer_closure_captures_a_stamp_taken_outside_it() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut found = Vec::new();
    for scanned in SCANNED {
        for file in rust_files(&root.join(scanned)) {
            let source = std::fs::read_to_string(&file).expect("read a source file");
            let relative = file
                .strip_prefix(root)
                .expect("under the crate")
                .to_string_lossy()
                .replace('\\', "/");
            for (function, binding) in scan(&source) {
                found.push(format!("{relative}::{function}::{binding}"));
            }
        }
    }
    let offenders: Vec<&String> = found
        .iter()
        .filter(|key| !ALLOWED.contains(&key.as_str()))
        .collect();
    assert!(
        offenders.is_empty(),
        "take the stamp inside the writer closure (#5849), or allow-list it with why it \
         writes no search input: {offenders:#?}"
    );
    let stale: Vec<&&str> = ALLOWED
        .iter()
        .filter(|key| !found.iter().any(|seen| seen == **key))
        .collect();
    assert!(
        stale.is_empty(),
        "allow-list entries that match nothing: {stale:?}"
    );
}

fn rust_files(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        return vec![path.to_owned()];
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(path).expect("list a source directory") {
        let path = entry.expect("a directory entry").path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if name != "tests" {
                files.extend(rust_files(&path));
            }
        } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// `(enclosing fn, binding)` for every stamp a writer closure in `source`'s
/// production code captures. A Windows checkout has CRLF line endings, and
/// every match here expects `\n`.
fn scan(source: &str) -> Vec<(String, String)> {
    captured_stamps(&without_comments(production(&source.replace("\r\n", "\n"))))
}

/// The file without its inline `#[cfg(test)] mod tests`.
fn production(source: &str) -> &str {
    source
        .find("#[cfg(test)]\nmod tests")
        .map_or(source, |at| &source[..at])
}

/// `source` with every `//` comment blanked, strings kept.
fn without_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => index = skip_string(bytes, index),
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    out[index] = b' ';
                    index += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    String::from_utf8(out).expect("utf-8")
}

/// `(enclosing fn, binding)` for every stamp a writer closure captures.
fn captured_stamps(source: &str) -> Vec<(String, String)> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(offset) = source[from..].find('|') {
        let open = from + offset;
        from = open + 1;
        let Some(params_len) = source[open + 1..].find('|') else {
            break;
        };
        let params = &source[open + 1..open + 1 + params_len];
        let first = params.split([':', ',']).next().unwrap_or("").trim();
        if !matches!(first, "conn" | "txn" | "tx") || params.contains('\n') {
            continue;
        }
        let body_start = open + 1 + params_len + 1;
        let body = closure_body(bytes, body_start);
        let function = enclosing_fn(&source[..open]);
        for stamp in STAMPS {
            if params
                .split(',')
                .any(|param| param.trim().starts_with(stamp))
            {
                continue;
            }
            if uses_unbound(body, stamp) {
                out.push((function.clone(), (*stamp).to_owned()));
            }
        }
        from = body_start;
    }
    out.sort();
    out.dedup();
    out
}

/// The closure body from `start`: a `{ ... }` block, or an expression that ends
/// at a `,`, `;` or an unmatched `)`.
fn closure_body(bytes: &[u8], start: usize) -> &str {
    let mut at = start;
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    let block = bytes.get(at) == Some(&b'{');
    let mut depth = 0i32;
    let mut index = at;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => index = skip_string(bytes, index),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth < 0 || (block && depth == 0) {
                    let end = if block { index + 1 } else { index };
                    return std::str::from_utf8(&bytes[at..end]).expect("utf-8");
                }
            }
            b',' | b';' if depth == 0 && !block => break,
            _ => {}
        }
        index += 1;
    }
    std::str::from_utf8(&bytes[at..index.min(bytes.len())]).expect("utf-8")
}

/// The index of the closing quote of the string opened at `open`.
fn skip_string(bytes: &[u8], open: usize) -> usize {
    let mut index = open + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'"' => return index,
            _ => {}
        }
        index += 1;
    }
    index
}

fn enclosing_fn(before: &str) -> String {
    before
        .rfind("fn ")
        .map(|at| {
            before[at + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `body` reads `name` as a value it does not bind itself.
fn uses_unbound(body: &str, name: &str) -> bool {
    let bytes = body.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut used = false;
    let mut from = 0;
    while let Some(offset) = body[from..].find(name) {
        let at = from + offset;
        let end = at + name.len();
        from = end;
        if at > 0 && word(bytes[at - 1]) || end < bytes.len() && word(bytes[end]) {
            continue;
        }
        let before = body[..at].trim_end();
        let after = body[end..].trim_start();
        // A field (`row.at`), a path (`x::at`), a call (`now_ms()`), a field
        // initialiser or a type ascription (`at: i64`).
        if before.ends_with('.')
            || before.ends_with("::")
            || after.starts_with('(')
            || after.starts_with("::")
            || (after.starts_with(':') && !after.starts_with("::"))
        {
            continue;
        }
        if before.ends_with("let") || before.ends_with("let mut") || binds(before) {
            return false;
        }
        used = true;
    }
    used
}

/// Whether `before` ends inside the pattern of a `let`, `for` or `if let`
/// (`let (a, `), so the name after it is bound there.
fn binds(before: &str) -> bool {
    let statement = before
        .rsplit([';', '{', '}'])
        .next()
        .unwrap_or("")
        .trim_start();
    (statement.starts_with("let ")
        || statement.starts_with("for ")
        || statement.starts_with("if let "))
        && !statement.contains('=')
}
