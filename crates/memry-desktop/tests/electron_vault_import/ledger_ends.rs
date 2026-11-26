//! The index.db ledger ends this build reads. 0037 is the last shipped Electron release
//! (v2026-11-23); 0038 and 0039 come from newer main builds. `TABLE_MAP` reads all three alike.

use rusqlite::Connection;

use super::{Vault, electron_db, import};

/// Rebuilds the vault's index.db with the frozen index journal applied up to and including `tag`.
pub(super) fn index_at(vault: &Vault, tag: &str) {
    let journal = electron_db::journal(electron_db::INDEX_DIR);
    let upto = journal.iter().position(|(t, _)| t == tag).unwrap() + 1;
    std::fs::remove_file(&vault.pair.index).unwrap();
    let conn = Connection::open(&vault.pair.index).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    electron_db::replay(&conn, electron_db::INDEX_DIR, Some(upto));
    for ddl in electron_db::INDEX_CODE_DDL {
        conn.execute_batch(ddl).unwrap();
    }
}

#[test]
fn an_index_at_each_known_ledger_end_imports() {
    for tag in [
        "0037_note_pending_write_hash",
        "0038_note_property_yaml_string",
        "0039_note_embedding_input_hash",
    ] {
        let vault = Vault::new();
        index_at(&vault, tag);
        import(&vault);
    }
}
