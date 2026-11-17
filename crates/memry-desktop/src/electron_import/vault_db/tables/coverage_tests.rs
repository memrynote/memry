//! `TABLE_MAP` against the frozen Electron schema and the live Electron sources.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::*;

use crate::electron_import::vault_db::electron_db;

fn replayed(dir: &str) -> BTreeSet<String> {
    let conn = Connection::open_in_memory().unwrap();
    electron_db::replay(&conn, dir, None);
    electron_db::tables(&conn)
        .into_iter()
        .map(|(name, _)| name)
        .filter(|name| name != LEDGER_TABLE)
        .collect()
}

fn mapped(db: SourceDb, origin: Origin) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for m in TABLE_MAP
        .iter()
        .filter(|m| m.db == db && m.origin == origin)
    {
        *counts.entry(m.table).or_default() += 1;
    }
    counts
}

#[test]
fn every_drizzle_table_has_a_mapping_or_a_skip_reason() {
    for (db, dir) in [
        (SourceDb::Data, electron_db::DATA_DIR),
        (SourceDb::Index, electron_db::INDEX_DIR),
    ] {
        let tables = replayed(dir);
        let mapped = mapped(db, Origin::Migration);
        for table in &tables {
            assert_eq!(
                mapped.get(table.as_str()),
                Some(&1),
                "{} table {table} needs exactly one TABLE_MAP entry",
                db.name()
            );
        }
        for table in mapped.keys() {
            assert!(
                tables.contains(*table),
                "TABLE_MAP names {} table {table}, which the migrations do not create",
                db.name()
            );
        }
    }
    assert_eq!(replayed(electron_db::DATA_DIR).len(), 65);
    assert_eq!(replayed(electron_db::INDEX_DIR).len(), 16);

    let virtuals: Vec<_> = TABLE_MAP
        .iter()
        .filter(|m| m.table.starts_with("fts_") || m.table.starts_with("vec_"))
        .collect();
    assert_eq!(virtuals.len(), 8, "the eight virtual tables are listed");
    for m in virtuals {
        let expected = if m.table.starts_with("fts_") {
            "rebuild"
        } else {
            "copy"
        };
        assert_eq!((m.table, m.class.as_str()), (m.table, expected));
        assert_eq!(m.origin, Origin::Code, "{}", m.table);
    }

    for m in TABLE_MAP {
        if matches!(m.class, Class::Skip) {
            assert!(m.reason.len() >= 40, "{}: skip reason too short", m.table);
        }
        if let Some(Importer::Pending(stage)) = m.class.importer() {
            assert!(
                ["36b", "36c", "36d1", "36d2", "36e", "36f"].contains(&stage),
                "{}: pending names no stage ({stage})",
                m.table
            );
        }
    }
}

#[test]
fn the_ledger_floor_is_the_last_frozen_migration() {
    for (dir, expected) in [
        (electron_db::DATA_DIR, ELECTRON_DATA_LAST_MIGRATION),
        (electron_db::INDEX_DIR, ELECTRON_INDEX_LAST_MIGRATION),
    ] {
        let last = electron_db::journal(dir)
            .into_iter()
            .map(|(_, when)| when)
            .max();
        assert_eq!(last, Some(expected), "{dir}");
    }
}

fn live_database_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src/main/database")
}

/// The files of one migration directory the replay reads: every `.sql` and the journal.
fn migration_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "sql") {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            files.insert(name, std::fs::read(&path).unwrap());
        }
    }
    files.insert(
        "meta/_journal.json".into(),
        std::fs::read(root.join("meta/_journal.json")).unwrap(),
    );
    files
}

/// Deleted with `apps/desktop` by Step 43 (#3560).
#[test]
fn electron_schema_fixture_matches_live_migrations() {
    let live = live_database_dir();
    if !live.exists() {
        return;
    }
    for dir in [electron_db::DATA_DIR, electron_db::INDEX_DIR] {
        let fixture = migration_files(&electron_db::schema_root().join(dir));
        let current = migration_files(&live.join(dir));
        let names = |files: &BTreeMap<String, Vec<u8>>| files.keys().cloned().collect::<Vec<_>>();
        assert_eq!(
            names(&fixture),
            names(&current),
            "{dir}: files added or removed"
        );
        for (name, bytes) in &current {
            assert!(
                fixture[name] == *bytes,
                "{dir}/{name} changed: copy it into tests/fixtures/electron-schema and extend TABLE_MAP"
            );
        }
    }
}

fn ts_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_dir() {
            if !name.starts_with("drizzle-") && name != "__tests__" {
                ts_sources(&path, out);
            }
        } else if name.ends_with(".ts") && !name.ends_with(".test.ts") {
            out.push(path);
        }
    }
}

/// Tables the Electron app creates in code are the `Origin::Code` entries, and the fixture
/// builder creates the same ones.
#[test]
fn code_created_tables_match_the_electron_sources() {
    let expected: BTreeSet<&str> = TABLE_MAP
        .iter()
        .filter(|m| m.origin == Origin::Code)
        .map(|m| m.table)
        .collect();

    let main = live_database_dir().join("..");
    if main.exists() {
        let create =
            regex::Regex::new(r#"CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS "?(\w+)"?"#).unwrap();
        let mut files = Vec::new();
        ts_sources(&main, &mut files);
        let mut found = BTreeSet::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            for capture in create.captures_iter(&text) {
                found.insert(capture[1].to_owned());
            }
        }
        let found: BTreeSet<&str> = found.iter().map(String::as_str).collect();
        assert_eq!(found, expected, "tables created in Electron code");
    }

    let dir = tempfile::tempdir().unwrap();
    let pair = electron_db::create_pair(dir.path());
    let mut built = BTreeSet::new();
    for (path, dir) in [
        (&pair.data, electron_db::DATA_DIR),
        (&pair.index, electron_db::INDEX_DIR),
    ] {
        let migrated = replayed(dir);
        let conn = Connection::open(path).unwrap();
        for (name, sql) in electron_db::tables(&conn) {
            let is_code_root = !migrated.contains(&name)
                && name != LEDGER_TABLE
                && (sql.starts_with("CREATE VIRTUAL") || name == "voice_embedding_state");
            if is_code_root {
                built.insert(name);
            }
        }
    }
    let built: BTreeSet<&str> = built.iter().map(String::as_str).collect();
    assert_eq!(
        built, expected,
        "tables the fixture builder creates in code"
    );
}
