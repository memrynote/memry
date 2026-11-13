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
