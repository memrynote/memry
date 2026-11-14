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

/// A filed PDF: a note row whose `file_type` is not markdown, with no body.
fn write_file_note(db: &Db, id: &str, title: &str) {
    write_note(db, id, title, "");
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "UPDATE notes SET file_type = 'pdf' WHERE id = ?1",
            params![id],
        )
        .expect("the update");
        Ok(())
    })
    .expect("the file type");
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
fn a_file_note_is_found_by_its_text_and_without_text_by_its_title() {
    let (db, vault) = vault("file-note-text");
    write_file_note(&db, "scan", "Invoice March");
    write_file_note(&db, "clip", "Holiday Video");
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
