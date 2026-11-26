//! A window's edit that waited for `data.db` while a reindex wrote its
//! watermark is stamped at or after it (#5849), so the next incremental
//! reindex reads the edit.

#![cfg(feature = "markdown")]

use crate::editor_support::{Replica, fixture};
use crate::stamp_gate::{RIVAL_NOTE, Search};

const WORD: &str = "wombatedit";

#[test]
fn an_edit_that_waited_through_a_reindex_is_indexed_next_pass() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("open");
    let update = Replica::from_state(42, &opened.state).block_without_id(&format!("A {WORD}."));
    let db = f.vault.db_handle();
    let search = Search::new(&db);

    let gate = search.gate();
    f.editor
        .apply_update(&note, &update, "main")
        .expect("the edit")
        .expect("the edit changed the body");
    gate.join();
    assert!(search.indexed(RIVAL_NOTE), "the gate reindexed");

    search.reindex();
    assert!(
        search.finds(WORD, &note),
        "the next reindex skipped the edit"
    );
}
