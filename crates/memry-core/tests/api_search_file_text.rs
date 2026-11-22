//! A note is found by the text read out of its files: a markdown note by its
//! attachments' text, a filed PDF or image by its own (Electron's
//! `search-projector.ts` `withAttachmentText` and `syncExtractedTextEntry`).
//!
//! Real SQLite, real FTS5: the text goes in through `Search::save_extracted_part`
//! and comes back through `Search::search`.
//!
//! One divergence from Electron: a file note with no text keeps its title row
//! (Electron drops it and finds the note by the fuzzy title fallback), so no hit
//! this index gives today is lost.

use memry_core::api::search::Search;
use memry_core::domain::file_text::{ExtractedTextMethod, OWN_FILE, TextSource};
use memry_core::domain::search::MatchKind;
use memry_core::storage::Db;
use std::cell::RefCell;

use memry_core::api::errors::StorageError;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{Connection, params};

use crate::api_search::{vault, write_note};

fn source(note_id: &str, source: &str) -> TextSource {
    TextSource {
        note_id: note_id.into(),
        source: source.into(),
    }
}

fn save(search: &Search, of: TextSource, text: &str) {
    search
        .save_extracted_part(of, 1, ExtractedTextMethod::PdfText, text.into())
        .expect("save the part");
}

/// The ids of the full-text hits for `query`; the fuzzy title fallback is left out.
fn found(search: &Search, query: &str) -> Vec<String> {
    let mut ids: Vec<String> = search
        .search(query.to_owned(), None, 10)
        .expect("the search")
        .notes
        .into_iter()
        .filter(|hit| hit.match_kind == MatchKind::Body)
        .map(|hit| hit.id)
        .collect();
    ids.sort();
    ids
}

/// Drops the watermark, which the next reindex reads as "rebuild everything".
fn force_full_rebuild(search: &Search) {
    search
        .index_handle()
        .call_blocking(|index: &mut Connection| {
            index
                .execute(
                    "DELETE FROM index_meta WHERE key = 'watermark.fts_notes'",
                    [],
                )
                .expect("the delete");
            Ok(())
        })
        .expect("drop the watermark");
}

#[test]
fn a_markdown_note_is_found_by_its_attachments_text() {
    let (db, vault) = vault("attachment-text");
    write_note(&db, "n1", "Trip", "flights and hotels");
    let search = vault.search().expect("the index");
    save(&search, source("n1", "receipt.pdf"), "Quittung Kardamom");

    assert!(search.reindex().expect("the reindex").full);
    assert_eq!(found(&search, "kardamom"), ["n1"]);
    assert_eq!(found(&search, "hotels"), ["n1"], "the body still counts");

    force_full_rebuild(&search);
    assert!(search.reindex().expect("the rebuild").full);
    assert_eq!(found(&search, "kardamom"), ["n1"], "a rebuild keeps it");
}

#[test]
fn a_bodyless_note_is_found_by_its_own_file_text_and_without_text_by_its_title() {
    let (db, vault) = vault("file-note-text");
    write_note(&db, "scan", "Invoice March", "");
    write_note(&db, "clip", "Holiday Video", "");
    let search = vault.search().expect("the index");
    save(&search, source("scan", OWN_FILE), "Rechnung Kardamom");

    search.reindex().expect("the reindex");
    assert_eq!(found(&search, "kardamom"), ["scan"]);
    assert_eq!(found(&search, "invoice"), ["scan"], "the title row stays");
    assert_eq!(
        found(&search, "holiday"),
        ["clip"],
        "no text, still a title row"
    );

    force_full_rebuild(&search);
    assert!(search.reindex().expect("the rebuild").full);
    assert_eq!(found(&search, "kardamom"), ["scan"]);
    assert_eq!(found(&search, "holiday"), ["clip"]);
}

#[test]
fn refreshing_one_note_picks_up_text_saved_after_its_reindex() {
    let (db, vault) = vault("refresh-note-text");
    write_note(&db, "n1", "Trip", "flights and hotels");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");
    assert!(found(&search, "kardamom").is_empty());

    // Saving the text moves no data.db stamp, so the refresh is what reaches the note.
    save(&search, source("n1", "receipt.pdf"), "Quittung Kardamom");
    assert!(found(&search, "kardamom").is_empty());

    search.refresh_note_text("n1").expect("the refresh");
    assert_eq!(found(&search, "kardamom"), ["n1"]);
    assert_eq!(found(&search, "trip"), ["n1"], "the title is kept");
    assert_eq!(found(&search, "hotels"), ["n1"], "the body is kept");

    search
        .delete_text_source(source("n1", "receipt.pdf"))
        .expect("delete the text");
    search.refresh_note_text("n1").expect("the refresh");
    assert!(found(&search, "kardamom").is_empty());
    assert_eq!(found(&search, "hotels"), ["n1"]);
}

#[test]
fn refreshing_a_note_the_index_has_not_reached_writes_no_row() {
    let (db, vault) = vault("refresh-unindexed");
    write_note(&db, "n1", "Trip", "");
    let search = vault.search().expect("the index");
    save(&search, source("n1", "receipt.pdf"), "Quittung Kardamom");

    search.refresh_note_text("n1").expect("the refresh");
    assert!(found(&search, "kardamom").is_empty());
    assert!(
        found(&search, "trip").is_empty(),
        "the reindex writes the row"
    );

    search.reindex().expect("the reindex");
    assert_eq!(found(&search, "kardamom"), ["n1"]);
}

/// Every `fts_notes` row, in id order: what a search reads.
fn rows(search: &Search) -> Vec<[String; 4]> {
    search
        .index_handle()
        .call_blocking(|index: &mut Connection| {
            let mut statement = index
                .prepare("SELECT id, title, content, tags FROM fts_notes ORDER BY id")
                .expect("the select");
            let rows = statement
                .query_map([], |row| {
                    Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?])
                })
                .expect("the rows")
                .collect::<Result<_, _>>()
                .expect("a row");
            Ok(rows)
        })
        .expect("the rows")
}

#[test]
fn refresh_then_reindex_leaves_what_a_full_rebuild_writes() {
    let (db, vault) = vault("refresh-equals-rebuild");
    write_note(&db, "n1", "Trip", "flights and hotels");
    write_note(&db, "scan", "Invoice March", "");
    write_note(&db, "plain", "Plain", "no files");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");

    save(&search, source("n1", "receipt.pdf"), "Quittung Kardamom");
    save(&search, source("scan", OWN_FILE), "Rechnung Zimt");
    search.refresh_note_text("n1").expect("the refresh");
    search.refresh_note_text("scan").expect("the refresh");
    assert!(!search.reindex().expect("the reindex").full);
    let refreshed = rows(&search);

    force_full_rebuild(&search);
    assert!(search.reindex().expect("the rebuild").full);
    assert_eq!(refreshed, rows(&search));
}

#[test]
fn refreshing_a_corrupt_note_is_an_error() {
    let (db, vault) = vault("refresh-corrupt");
    write_note(&db, "n1", "Trip", "flights");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");
    set_sync_item(&db, "n1", "corrupt_reason = 'unreadable'");

    let refreshed = search.refresh_note_text("n1");
    assert!(
        matches!(refreshed, Err(StorageError::Failed { .. })),
        "{refreshed:?}"
    );
}

#[test]
fn refreshing_a_deleted_note_is_an_error() {
    let (db, vault) = vault("refresh-deleted");
    write_note(&db, "n1", "Trip", "flights");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");
    set_sync_item(&db, "n1", "deleted_at = 1");
    search.reindex().expect("the reindex drops the row");

    let refreshed = search.refresh_note_text("n1");
    assert!(
        matches!(refreshed, Err(StorageError::NotFound { .. })),
        "{refreshed:?}"
    );
    let missing = search.refresh_note_text("never-written");
    assert!(
        matches!(missing, Err(StorageError::NotFound { .. })),
        "{missing:?}"
    );
}

fn set_sync_item(db: &Db, id: &str, assignment: &str) {
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            &format!("UPDATE sync_items SET {assignment} WHERE item_id = ?1"),
            params![id],
        )
        .expect("the update");
        Ok(())
    })
    .expect("the sync item");
}

thread_local! {
    /// The statements the traced index connection ran on this thread. `Db::call_blocking`
    /// runs on the caller's thread, so parallel tests do not see each other's.
    static STATEMENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn record(event: TraceEvent<'_>) {
    // FTS5's own statements on its shadow tables come through as `-- ` comments.
    if let TraceEvent::Stmt(statement, sql) = event
        && !sql.starts_with("-- ")
    {
        let sql = statement.expanded_sql().unwrap_or_else(|| sql.to_owned());
        STATEMENTS.with(|all| all.borrow_mut().push(sql));
    }
}

/// Runs `f` with every statement on `search`'s index connection recorded, and returns them.
fn traced(search: &Search, f: impl FnOnce()) -> Vec<String> {
    let index = search.index_handle();
    let set = |on: bool| {
        index
            .call_blocking(|index: &mut Connection| {
                index.trace_v2(
                    TraceEventCodes::SQLITE_TRACE_STMT,
                    on.then_some(record as _),
                );
                Ok(())
            })
            .expect("the trace");
    };
    STATEMENTS.with(|all| all.borrow_mut().clear());
    set(true);
    f();
    set(false);
    STATEMENTS.with(|all| all.take())
}

/// `fts_notes.id` is UNINDEXED, so `WHERE id = ?` scans the whole table: a rebuild that
/// ran one per note would be quadratic in the vault. Since #5417 an incremental pass also
/// replaces each row by its rowid, read once per pass.
#[test]
fn a_full_rebuild_runs_no_per_note_delete() {
    let (db, vault) = vault("rebuild-no-delete");
    write_note(&db, "n1", "Trip", "flights");
    write_note(&db, "n2", "Home", "garden");
    let search = vault.search().expect("the index");

    let per_note = |statements: &[String]| {
        statements
            .iter()
            .filter(|sql| sql.contains("DELETE FROM fts_notes WHERE id"))
            .count()
    };
    let rebuild = traced(&search, || {
        assert!(search.reindex().expect("the rebuild").full);
    });
    assert_eq!(per_note(&rebuild), 0, "{rebuild:#?}");

    write_note(&db, "n3", "Shop", "bread");
    let mut done = None;
    let incremental = traced(&search, || {
        done = Some(search.reindex().expect("the reindex"));
    });
    let done = done.expect("the pass");
    assert!(!done.full);
    assert!(done.notes_indexed > 0);
    assert_eq!(per_note(&incremental), 0, "{incremental:#?}");
    let (rows, ids): (i64, i64) = search
        .index_handle()
        .read_blocking(|index| {
            index
                .query_row(
                    "SELECT count(*), count(DISTINCT id) FROM fts_notes",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("count");
    assert_eq!(
        (rows, ids),
        (3, 3),
        "an incremental pass still replaces each row"
    );
}

#[test]
fn a_refresh_looks_the_row_up_once_and_updates_it_by_rowid() {
    let (db, vault) = vault("refresh-rowid");
    write_note(&db, "n1", "Trip", "flights");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");
    save(&search, source("n1", "receipt.pdf"), "Quittung Kardamom");

    let statements = traced(&search, || {
        search.refresh_note_text("n1").expect("the refresh");
    });
    let by_id: Vec<_> = statements
        .iter()
        .filter(|sql| sql.contains("fts_notes") && sql.contains("WHERE id"))
        .collect();
    assert_eq!(by_id.len(), 1, "{statements:#?}");
    assert!(
        statements
            .iter()
            .any(|sql| sql.contains("UPDATE fts_notes") && sql.contains("WHERE rowid")),
        "{statements:#?}"
    );
    assert_eq!(found(&search, "kardamom"), ["n1"]);
}
