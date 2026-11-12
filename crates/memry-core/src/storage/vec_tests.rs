use std::io::Read as _;
use std::path::Path;

use super::*;
use crate::storage::connection::{Db, Profile};
use crate::storage::index_db::open_or_rebuild;
use crate::storage::migrations::{INDEX_MIGRATIONS, latest_version, user_version};
use crate::storage::test_support::temp_dir;

const FIXTURE_DB: &[u8] = include_bytes!("../../tests/fixtures/index-vec-v6.db.gz");
const FIXTURE_ANSWERS: &str = include_str!("../../tests/fixtures/index-vec-v6.json");

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect(sql)
}

fn width(conn: &Connection, table: VecTable) -> Option<usize> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = ?1",
            [table.name()],
            |row| row.get(0),
        )
        .unwrap_or_else(|err| panic!("{}: {err}", table.name()));
    declared_width(&sql)
}

fn exec(db: &Db, sql: &str) {
    db.call_blocking(|conn| conn.execute_batch(sql).map_err(failed))
        .expect(sql);
}

fn unit(seed: f32) -> Vec<f32> {
    let raw: Vec<f32> = (0..EMBEDDING_DIMENSION)
        .map(|i| (seed + i as f32).sin())
        .collect();
    let norm = raw.iter().map(|v| v * v).sum::<f32>().sqrt();
    raw.into_iter().map(|v| v / norm).collect()
}

fn put(db: &Db, table: VecTable, id: &str, vector: &[f32]) {
    let blob = to_blob(vector);
    db.call_blocking(|conn| {
        conn.execute(
            &format!(
                "INSERT INTO {} ({}, embedding) VALUES (?1, ?2)",
                table.name(),
                table.id_column()
            ),
            params![id, blob],
        )
        .map_err(failed)
    })
    .expect("insert a vector");
}

#[test]
fn a_new_index_has_every_vector_table_at_256_and_the_state_tables() {
    let dir = temp_dir("vec-new");
    let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");

    opened
        .db
        .call_blocking(|conn| {
            assert_eq!(user_version(conn)?, latest_version(INDEX_MIGRATIONS));
            for table in VecTable::ALL {
                assert_eq!(width(conn, table), Some(EMBEDDING_DIMENSION), "{table:?}");
            }
            for table in [
                "note_embedding_state",
                "image_embedding_state",
                "voice_embedding_state",
                "fts_inbox",
            ] {
                count(conn, &format!("SELECT COUNT(*) FROM {table}"));
            }
            Ok(())
        })
        .expect("read back");
}

#[test]
fn reopening_keeps_vectors_and_drops_nothing() {
    let dir = temp_dir("vec-reopen");
    let path = dir.path().join("index.db");
    let first = open_or_rebuild(&path).expect("first open");
    put(&first.db, VecTable::NoteSimilar, "a", &unit(1.0));
    drop(first);

    let second = open_or_rebuild(&path).expect("second open");
    let (stored, dropped) = second
        .db
        .call_blocking(|conn| {
            Ok((
                vector(conn, VecTable::NoteSimilar, "a")?,
                ensure_vec_tables(conn)?,
            ))
        })
        .expect("read back");
    assert_eq!(stored, Some(unit(1.0)));
    assert!(dropped.is_empty(), "{dropped:?}");
}

#[test]
fn a_note_table_of_another_width_drops_the_three_note_tables_only() {
    let dir = temp_dir("vec-note-width");
    let path = dir.path().join("index.db");
    let first = open_or_rebuild(&path).expect("first open");
    put(&first.db, VecTable::NoteSimilar, "a", &unit(1.0));
    put(&first.db, VecTable::Images, "a/x.png", &unit(2.0));
    exec(
        &first.db,
        "INSERT INTO note_embedding_state VALUES ('a', 6, 0);
         INSERT INTO image_embedding_state VALUES ('a', 'x.png', '1-2|0', 2);
         DROP TABLE vec_notes;
         CREATE VIRTUAL TABLE vec_notes USING vec0(
           note_id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine);",
    );
    drop(first);

    let second = open_or_rebuild(&path).expect("second open");
    second
        .db
        .call_blocking(|conn| {
            assert_eq!(width(conn, VecTable::Notes), Some(EMBEDDING_DIMENSION));
            assert_eq!(count(conn, "SELECT COUNT(*) FROM vec_note_similar"), 0);
            assert_eq!(vector(conn, VecTable::Images, "a/x.png")?, Some(unit(2.0)));
            // The reconcile re-embeds a note with no vector; its state row stays,
            // as in Electron.
            assert_eq!(count(conn, "SELECT COUNT(*) FROM note_embedding_state"), 1);
            assert_eq!(count(conn, "SELECT COUNT(*) FROM image_embedding_state"), 1);
            Ok(())
        })
        .expect("read back");
}

#[test]
fn an_image_or_voice_table_of_another_width_is_dropped_with_its_state() {
    let dir = temp_dir("vec-image-width");
    let path = dir.path().join("index.db");
    let first = open_or_rebuild(&path).expect("first open");
    put(&first.db, VecTable::Notes, "a", &unit(1.0));
    exec(
        &first.db,
        "INSERT INTO note_embedding_state VALUES ('a', 6, 0);
         INSERT INTO image_embedding_state VALUES ('a', 'x.png', '1-2|0', 2);
         INSERT INTO voice_embedding_state VALUES ('v', 'transcript', 1, 1);
         DROP TABLE vec_images;
         CREATE VIRTUAL TABLE vec_images USING vec0(
           image_key TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine);
         DROP TABLE vec_voice;
         CREATE VIRTUAL TABLE vec_voice USING vec0(
           chunk_id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine);",
    );
    drop(first);

    let second = open_or_rebuild(&path).expect("second open");
    second
        .db
        .call_blocking(|conn| {
            assert_eq!(width(conn, VecTable::Images), Some(EMBEDDING_DIMENSION));
            assert_eq!(width(conn, VecTable::Voice), Some(EMBEDDING_DIMENSION));
            assert_eq!(count(conn, "SELECT COUNT(*) FROM image_embedding_state"), 0);
            assert_eq!(count(conn, "SELECT COUNT(*) FROM voice_embedding_state"), 0);
            assert_eq!(vector(conn, VecTable::Notes, "a")?, Some(unit(1.0)));
            assert_eq!(count(conn, "SELECT COUNT(*) FROM note_embedding_state"), 1);
            Ok(())
        })
        .expect("read back");
}

#[test]
fn nearest_answers_closest_first_and_caps_k() {
    let dir = temp_dir("vec-nearest");
    let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");
    for (id, seed) in [("far", 40.0), ("same", 1.0), ("near", 1.05)] {
        put(&opened.db, VecTable::NoteSimilar, id, &unit(seed));
    }

    let (top, all, none) = opened
        .db
        .call_blocking(|conn| {
            Ok((
                nearest(conn, VecTable::NoteSimilar, &unit(1.0), 2)?,
                nearest(conn, VecTable::NoteSimilar, &unit(1.0), usize::MAX)?,
                nearest(conn, VecTable::NoteSimilar, &unit(1.0), 0)?,
            ))
        })
        .expect("query");

    let ids: Vec<&str> = top.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["same", "near"]);
    assert!(top[0].1.abs() < 1e-6, "{top:?}");
    assert_eq!(all.len(), 3);
    assert!(none.is_empty());
}

#[test]
fn a_blob_that_is_not_whole_floats_is_no_vector() {
    assert_eq!(from_blob(&[0, 0, 128]), None);
    assert_eq!(from_blob(&to_blob(&[1.5, -2.0])), Some(vec![1.5, -2.0]));
}

fn unpack_fixture(path: &Path) {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(FIXTURE_DB)
        .read_to_end(&mut bytes)
        .expect("gunzip the fixture");
    std::fs::write(path, bytes).expect("write the fixture");
}

/// An index at migration 6 holding vec0 rows that Electron's sqlite-vec wrote
/// (`apps/desktop/scripts/vec-index-oracle/generate.cjs`) migrates in place, keeps
/// every vector, drops its 768-wide `vec_images`, and answers Electron's `k = 30`
/// query with Electron's ids and distances.
#[test]
fn an_index_with_electron_vectors_survives_the_migration_and_answers_like_electron() {
    let dir = temp_dir("vec-fixture");
    let path = dir.path().join("index.db");
    unpack_fixture(&path);
    let oracle: serde_json::Value = serde_json::from_str(FIXTURE_ANSWERS).expect("answers");
    let k = oracle["k"].as_u64().expect("k") as usize;
    let queries: Vec<Vec<f32>> = oracle["queries"]
        .as_array()
        .expect("queries")
        .iter()
        .map(|q| {
            q.as_array()
                .expect("a query")
                .iter()
                .map(|v| v.as_f64().expect("a number") as f32)
                .collect()
        })
        .collect();

    let opened = open_or_rebuild(&path).expect("open");
    assert!(
        opened.rebuild_reason.is_none(),
        "{:?}",
        opened.rebuild_reason
    );
    opened
        .db
        .call_blocking(|conn| {
            assert_eq!(user_version(conn)?, latest_version(INDEX_MIGRATIONS));
            assert_eq!(width(conn, VecTable::Images), Some(EMBEDDING_DIMENSION));
            assert_eq!(count(conn, "SELECT COUNT(*) FROM vec_images"), 0);
            assert_eq!(count(conn, "SELECT COUNT(*) FROM voice_embedding_state"), 6);
            assert_eq!(
                vector(conn, VecTable::NoteSimilar, "n03")?.as_ref(),
                Some(&queries[0])
            );
            for table in [
                VecTable::Notes,
                VecTable::NoteChunks,
                VecTable::NoteSimilar,
                VecTable::Voice,
            ] {
                let rows = oracle["rows"][table.name()].as_i64().expect("rows");
                let stored = count(conn, &format!("SELECT COUNT(*) FROM {}", table.name()));
                assert_eq!(stored, rows, "{table:?}");
                for (query, expected) in queries
                    .iter()
                    .zip(oracle["answers"][table.name()].as_array().expect("answers"))
                {
                    let expected: Vec<(String, f64)> = expected
                        .as_array()
                        .expect("an answer")
                        .iter()
                        .map(|hit| {
                            (
                                hit[0].as_str().expect("id").to_owned(),
                                hit[1].as_f64().expect("distance"),
                            )
                        })
                        .collect();
                    let actual = nearest(conn, table, query, k)?;
                    let ids = |hits: &[(String, f64)]| -> Vec<String> {
                        hits.iter().map(|(id, _)| id.clone()).collect()
                    };
                    assert_eq!(ids(&actual), ids(&expected), "{table:?}");
                    for ((_, got), (id, want)) in actual.iter().zip(&expected) {
                        assert!((got - want).abs() < 1e-6, "{table:?} {id}: {got} vs {want}");
                    }
                }
            }
            Ok(())
        })
        .expect("read back");
}

/// The fixture is what the test above takes it for: an index at migration 6 with
/// a `vec_images` from an older model.
#[test]
fn the_fixture_is_an_index_at_migration_6_with_a_768_wide_image_table() {
    let dir = temp_dir("vec-fixture-raw");
    let path = dir.path().join("index.db");
    unpack_fixture(&path);
    let db = Db::open_with(&path, Profile::Index).expect("open");
    db.call_blocking(|conn| {
        assert_eq!(user_version(conn)?, 6);
        assert_eq!(width(conn, VecTable::Images), Some(768));
        Ok(())
    })
    .expect("read back");
}
