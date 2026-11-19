//! Stage 36e: the text Electron read out of files, the vectors and their state rows.
//!
//! `fixtures/electron-vectors/index.db` holds a `vec_notes` table Electron's own sqlite-vec
//! (0.1.7-alpha.2) wrote, with three vectors Electron's text path stored for
//! `embeddings-text.json` texts 0-2 (`generate.py`). The other vec0 tables are written here by
//! the core's sqlite-vec with Electron's DDL.

use std::path::Path;

use memry_core::domain::note_embeddings::{candidates, embedded_hash, owed, with_file_text};
use memry_core::storage::import::{DATA_FILE, INDEX_FILE};
use memry_desktop::electron_import::ProfileLock;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::docs::folded;
use super::queue::{seed_note, text};
use super::{ELECTRON_DEVICE, Vault, electron_db, electron_profile, import};

const KEPT: &str = "Vec-kept0001";
const EDITED: &str = "Vec-edit0001";
const DIRTY: &str = "Vec-dirty001";
/// What `seed_note` writes to each note's file.
const FILE: &str = "---\ntags: daily\n---\n\nToday.\n\n";

/// `(table, columns)` of every table this stage copies.
const TABLES: &[(&str, &str)] = &[
    ("extracted_text", "note_id, source, part, method, text"),
    (
        "file_text_jobs",
        "note_id, source, signature, status, page_count, error, app_version, updated_at, \
         ocr_languages",
    ),
    (
        "note_embedding_state",
        "note_id, input_version, chunk_count",
    ),
    (
        "image_embedding_state",
        "note_id, source, signature, input_version",
    ),
    (
        "voice_embedding_state",
        "item_id, source, input_version, chunks",
    ),
    ("vec_notes", "note_id, embedding"),
    ("vec_note_chunks", "chunk_id, embedding"),
    ("vec_note_similar", "note_id, embedding"),
    ("vec_images", "image_key, embedding"),
    ("vec_voice", "chunk_id, embedding"),
];

/// A vault whose Electron `index.db` starts as the fixture.
fn vault_with_electron_vectors() -> Vault {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let memry = root.join(".memry");
    std::fs::create_dir_all(&memry).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/electron-vectors")
        .join(INDEX_FILE);
    std::fs::copy(fixture, memry.join(INDEX_FILE)).unwrap();
    let pair = electron_db::create_pair(&memry);
    let profile = electron_profile(dir.path());
    let lock = ProfileLock::probe(&profile).unwrap();
    Vault {
        _dir: dir,
        root,
        pair,
        profile,
        lock,
        device_id: Some(ELECTRON_DEVICE),
    }
}

fn vector(seed: f32, width: usize) -> Vec<u8> {
    (0..width)
        .flat_map(|i| (seed + i as f32 / 1000.0).to_le_bytes())
        .collect()
}

/// Every row of `table`, sorted.
fn rows(conn: &Connection, table: &str, columns: &str) -> Vec<Vec<Value>> {
    let width = columns.split(',').count();
    let mut stmt = conn
        .prepare(&format!("SELECT {columns} FROM {table}"))
        .unwrap();
    let mut rows: Vec<Vec<Value>> = stmt
        .query_map([], |row| (0..width).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows.sort_by_key(|row| format!("{row:?}"));
    rows
}

/// Electron's `note_cache` row of a note it last read as `read`, under `title`.
fn cache(index: &Connection, id: &str, read: &str) {
    electron_db::seed(
        index,
        "note_cache",
        &[
            ("id", text(id)),
            ("path", text(&format!("{id}.md"))),
            ("title", text(id)),
            (
                "content_hash",
                text(&memry_desktop::vault::hash::content_hash(read)),
            ),
        ],
    );
}

fn electron_vector(n: usize) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/embeddings-text.json");
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    json["texts"][n]["embedding"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|v| (v.as_f64().unwrap() as f32).to_le_bytes())
        .collect()
}

/// Every row reaches the core index unchanged, Electron's vectors byte for byte, and only the
/// notes Electron itself owed a vector (edited since it last read them, or marked dirty) are
/// owed one by the core's embedding reconcile.
#[test]
fn derived_rows_import_unchanged_and_only_changed_notes_owe_a_vector() {
    let vault = vault_with_electron_vectors();
    let index = Connection::open(&vault.pair.index).unwrap();
    for id in [KEPT, EDITED, DIRTY] {
        seed_note(&vault, id, &format!("{id}.md"), None, false);
        cache(&index, id, if id == EDITED { "Yesterday.\n" } else { FILE });
    }
    index
        .execute_batch(&format!(
            "INSERT INTO note_embedding_state VALUES ('{KEPT}', 6, 1), ('{EDITED}', 6, 0),
               ('{DIRTY}', 0, 0);
             INSERT INTO extracted_text VALUES ('{KEPT}', 'a.pdf', 1, 'pdf-text', 'Attached words');
             INSERT INTO file_text_jobs VALUES ('{KEPT}', 'a.pdf', '12:34', 'done', 1, NULL,
               '1.9.0', '2026-01-05T10:00:00.000Z', 'eng+deu');
             INSERT INTO image_embedding_state VALUES ('{KEPT}', 'pic.png', '9:8', 2);
             INSERT INTO voice_embedding_state VALUES ('voice-1', 'transcript', 6, 1);"
        ))
        .unwrap();
    for (table, id, seed) in [
        ("vec_note_chunks", format!("{KEPT}#1"), 0.1),
        ("vec_note_similar", KEPT.to_owned(), 0.2),
        ("vec_images", format!("{KEPT}/pic.png"), 0.3),
        ("vec_voice", "voice-1#0".to_owned(), 0.4),
    ] {
        index
            .execute(
                &format!("INSERT INTO {table} VALUES (?1, ?2)"),
                rusqlite::params![id, vector(seed, 256)],
            )
            .unwrap();
    }

    let docs = [KEPT, EDITED, DIRTY]
        .map(|id| folded(id, "Today.\n", None))
        .into();
    let staged = super::staged(
        memry_desktop::electron_import::vault_db::stage_vault_import(
            memry_desktop::electron_import::vault_db::VaultImportInput {
                docs,
                ..vault.input()
            },
        )
        .unwrap(),
    );
    let report = staged.report().clone();
    staged.install().unwrap();

    let core_index = Connection::open(vault.core().join(INDEX_FILE)).unwrap();
    let core_data = Connection::open(vault.core().join(DATA_FILE)).unwrap();
    for (table, columns) in TABLES {
        let source = rows(&index, table, columns);
        assert!(!source.is_empty(), "{table}");
        assert_eq!(rows(&core_index, table, columns), source, "{table}");
        let counted = &report.tables[&format!("index.db/{table}")];
        assert_eq!(
            (counted.target_count, counted.dropped),
            (source.len() as u64, 0),
            "{table}"
        );
    }
    let stored: Vec<u8> = core_index
        .query_row(
            "SELECT embedding FROM vec_notes WHERE note_id = ?1",
            [KEPT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, electron_vector(0));

    let notes = with_file_text(&core_index, candidates(&core_data).unwrap()).unwrap();
    let mut owed: Vec<String> = owed(&core_index, notes)
        .unwrap()
        .into_iter()
        .map(|note| note.note_id)
        .collect();
    owed.sort();
    assert_eq!(owed, [DIRTY, EDITED]);
}

/// Electron caches no hash for a filed file (`persistFileNote`, `note-derived-state-projector.ts:240`)
/// nor for a markdown note its tier 0 has not read. The filed PDF records the hash the core
/// computes for it (`embedded_hash(None, text)`), so it owes nothing; the markdown note
/// records none and stays owed.
#[test]
fn notes_without_a_cached_hash_import_and_only_markdown_ones_stay_owed() {
    const PDF: &str = "pdf1";
    const TIER0: &str = "Vec-tier0001";
    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "note_metadata",
        &[
            ("id", text(PDF)),
            ("path", text("Files/doc.pdf")),
            ("title", text("doc")),
            ("file_type", text("pdf")),
            ("created_at", text("2026-01-05T08:00:00.000Z")),
            ("modified_at", text("2026-01-05T09:00:00.000Z")),
        ],
    );
    seed_note(&vault, TIER0, &format!("{TIER0}.md"), None, false);
    let index = Connection::open(&vault.pair.index).unwrap();
    for (id, path, title, file_type) in [
        (PDF, "Files/doc.pdf", "doc", "pdf"),
        (TIER0, &format!("{TIER0}.md"), TIER0, "markdown"),
    ] {
        electron_db::seed(
            &index,
            "note_cache",
            &[
                ("id", text(id)),
                ("path", text(path)),
                ("title", text(title)),
                ("file_type", text(file_type)),
            ],
        );
        index
            .execute(
                "INSERT INTO vec_notes VALUES (?1, ?2)",
                rusqlite::params![id, vector(0.1, 256)],
            )
            .unwrap();
    }
    index
        .execute_batch(&format!(
            "INSERT INTO note_embedding_state VALUES ('{PDF}', 6, 0), ('{TIER0}', 6, 0);
             INSERT INTO extracted_text VALUES ('{PDF}', 'doc.pdf', 1, 'pdf-text', 'Scanned words');"
        ))
        .unwrap();

    let staged = super::staged(
        memry_desktop::electron_import::vault_db::stage_vault_import(
            memry_desktop::electron_import::vault_db::VaultImportInput {
                docs: vec![folded(TIER0, "Today.\n", None)],
                ..vault.input()
            },
        )
        .unwrap(),
    );
    staged.install().unwrap();

    let core_index = Connection::open(vault.core().join(INDEX_FILE)).unwrap();
    let core_data = Connection::open(vault.core().join(DATA_FILE)).unwrap();
    let recorded: Vec<(String, Option<String>)> = core_index
        .prepare("SELECT note_id, content_hash FROM note_embedding_hashes ORDER BY note_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let notes = with_file_text(&core_index, candidates(&core_data).unwrap()).unwrap();
    let pdf = notes.iter().find(|note| note.note_id == PDF).unwrap();
    assert_eq!(
        recorded,
        [(PDF.to_owned(), embedded_hash(None, "Scanned words"))]
    );
    assert_eq!(recorded[0].1, pdf.content_hash);
    let owed: Vec<String> = owed(&core_index, notes)
        .unwrap()
        .into_iter()
        .map(|note| note.note_id)
        .collect();
    assert_eq!(owed, [TIER0]);
}

/// A vec0 table of another width cannot go into the core's 256 wide one: its family and state
/// rows are dropped and counted, and every other family is copied.
#[test]
fn a_vector_table_of_another_width_drops_only_its_family() {
    let vault = Vault::new();
    let index = Connection::open(&vault.pair.index).unwrap();
    electron_db::seed(&index, "note_cache", &[("id", text("n1"))]);
    index
        .execute_batch(
            "DROP TABLE vec_images;
             CREATE VIRTUAL TABLE vec_images USING vec0(
               image_key TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine);
             INSERT INTO image_embedding_state VALUES ('n1', 'pic.png', '9:8', 2);",
        )
        .unwrap();
    index
        .execute(
            "INSERT INTO vec_images VALUES ('n1/pic.png', ?1)",
            [vector(0.3, 384)],
        )
        .unwrap();
    index
        .execute(
            "INSERT INTO vec_notes VALUES ('n1', ?1)",
            [vector(0.1, 256)],
        )
        .unwrap();

    let report = import(&vault);
    for (table, written, dropped) in [
        ("vec_images", 0, 1),
        ("image_embedding_state", 0, 1),
        ("vec_notes", 1, 0),
    ] {
        let counted = &report.tables[&format!("index.db/{table}")];
        assert_eq!(
            (counted.target_count, counted.dropped),
            (written, dropped),
            "{table}"
        );
    }
    assert_eq!(report.dropped["vectorsOfAnotherWidth"], 2);
    let core_index = Connection::open(vault.core().join(INDEX_FILE)).unwrap();
    for (table, expected) in [
        ("vec_images", 0),
        ("image_embedding_state", 0),
        ("vec_notes", 1),
    ] {
        let count: i64 = core_index
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, expected, "{table}");
    }
}
