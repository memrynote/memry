//! Each list is the sequence its directory spells: versions 1, 2, 3 and on with no gap or
//! repeat, and the file named `NNNN_<name>.sql` is version NNNN, named `<name>`, with that
//! file's text. A shift of feat/tauri-v2's own migrations above main's (#4438) that misses a
//! file name, a registry entry or a version fails here.

use std::path::Path;

use super::*;

#[test]
fn versions_are_strictly_ascending_from_one() {
    for migrations in [DATA_MIGRATIONS, INDEX_MIGRATIONS] {
        for (index, migration) in migrations.iter().enumerate() {
            let expected = u32::try_from(index + 1).expect("migration count fits u32");
            assert_eq!(migration.version, expected, "{}", migration.name);
        }
    }
}

#[test]
fn every_migration_file_is_its_numbered_entry() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/storage/migrations");
    for (dir, migrations) in [("data", DATA_MIGRATIONS), ("index", INDEX_MIGRATIONS)] {
        let mut files: Vec<_> = std::fs::read_dir(root.join(dir))
            .expect("list the migrations")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .into_string()
                    .expect("utf-8")
            })
            .filter(|name| name.ends_with(".sql"))
            .collect();
        files.sort();
        let listed: Vec<_> = migrations
            .iter()
            .map(|m| format!("{:04}_{}.sql", m.version, m.name))
            .collect();
        assert_eq!(files, listed, "{dir}");
        for (file, migration) in files.iter().zip(migrations) {
            let text = std::fs::read_to_string(root.join(dir).join(file)).expect("read");
            assert_eq!(text, migration.sql, "{dir}/{file}");
        }
    }
}

/// `fts_inbox` as main's index migration 0003 (#4419) creates it, desktop's `fts-inbox.ts`
/// columns: the order is what `INBOX_RANK`'s weights refer to.
fn fts_inbox(conn: &rusqlite::Connection) -> Vec<(String, Option<String>)> {
    let mut statement = conn
        .prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'fts_inbox'")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// The shifted index list runs on a fresh file and on one main left at its version 3, and
/// either way ends with one `fts_inbox`, main's, with the rows main's build wrote.
#[test]
fn the_index_list_runs_fresh_and_over_mains_version_3_with_one_fts_inbox() {
    let mut fresh = rusqlite::Connection::open_in_memory().expect("open");
    run_atomic(&mut fresh, INDEX_MIGRATIONS).expect("fresh");
    let expected = fts_inbox(&fresh);
    assert_eq!(expected.len(), 1, "{expected:?}");
    assert!(
        expected[0].1.as_deref().is_some_and(|sql| sql.contains(
            "id UNINDEXED,\n  title,\n  content,\n  transcription,\n  source_title,\n  \
             tokenize = 'porter unicode61'"
        )),
        "{expected:?}"
    );

    let mut main = rusqlite::Connection::open_in_memory().expect("open");
    assert_eq!(
        run_atomic(&mut main, &INDEX_MIGRATIONS[..3]).expect("main"),
        3
    );
    assert_eq!(INDEX_MIGRATIONS[2].name, "fts_inbox");
    main.execute_batch(
        "INSERT INTO fts_inbox (id, title, content, transcription, source_title)
         VALUES ('c1', 'Osprey', '', '', '')",
    )
    .expect("a row main's build indexed");
    assert_eq!(
        run_atomic(&mut main, INDEX_MIGRATIONS).expect("step forward"),
        latest_version(INDEX_MIGRATIONS)
    );
    assert_eq!(fts_inbox(&main), expected);
    let kept: i64 = main
        .query_row(
            "SELECT count(*) FROM fts_inbox WHERE fts_inbox MATCH 'osprey'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(kept, 1);
}
