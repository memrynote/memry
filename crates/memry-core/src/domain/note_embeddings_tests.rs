//! The store half of Electron's `embedding-projector.test.ts` and
//! `embedding-projector-recovery.test.ts`, on a real `index.db` with vec0.

use super::*;
use crate::storage::test_support::temp_dir;
use crate::storage::vec::{EMBEDDING_DIMENSION, VecTable, vector};
use crate::storage::{Db, open_data, open_index};

struct Dbs {
    _dir: crate::storage::test_support::TempDir,
    data: Db,
    index: Db,
}

fn dbs() -> Dbs {
    let dir = temp_dir("note-embeddings");
    let data = open_data(&dir.path().join("data.db")).expect("data.db");
    let index = open_index(&dir.path().join("index.db"))
        .expect("index.db")
        .db;
    Dbs {
        _dir: dir,
        data,
        index,
    }
}

fn v(seed: f32) -> Vec<f32> {
    (0..EMBEDDING_DIMENSION)
        .map(|i| seed + i as f32 / 1000.0)
        .collect()
}

impl Dbs {
    fn file(&self, id: &str, path: &str, file_type: &str, title: Option<&str>) {
        let (id, path, file_type, title) = (
            id.to_owned(),
            path.to_owned(),
            file_type.to_owned(),
            title.map(str::to_owned),
        );
        self.data
            .call_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO note_files (note_id, path, file_type, indexed_at) \
                     VALUES (?1, ?2, ?3, 1)",
                    params![id, path, file_type],
                )
                .map_err(failed)?;
                if let Some(title) = title {
                    conn.execute(
                        "INSERT INTO notes (id, title, created_at, modified_at) \
                         VALUES (?1, ?2, 1, 1)",
                        params![id, title],
                    )
                    .map_err(failed)?;
                }
                Ok(())
            })
            .expect("a note");
    }

    /// The note's `note_files.content_hash`, and the file hash of its last read.
    fn hashes(&self, id: &'static str, content: Option<&'static str>, file: Option<&'static str>) {
        self.data
            .call_blocking(move |conn| {
                conn.execute(
                    "UPDATE note_files SET content_hash = ?2 WHERE note_id = ?1",
                    params![id, content],
                )
                .map_err(failed)?;
                conn.execute("DELETE FROM note_file_hashes WHERE note_id = ?1", [id])
                    .map_err(failed)?;
                if let Some(file) = file {
                    conn.execute(
                        "INSERT INTO note_file_hashes (note_id, file_hash) VALUES (?1, ?2)",
                        params![id, file],
                    )
                    .map_err(failed)?;
                }
                Ok(())
            })
            .expect("hashes");
    }

    fn index<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StorageError> + Send + 'static,
    ) -> T {
        self.index
            .call_blocking(move |conn| f(conn))
            .expect("index")
    }

    fn count(&self, sql: &'static str) -> i64 {
        self.index(move |conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
    }

    fn state(&self, id: &'static str) -> Option<(i64, i64)> {
        self.index(move |conn| {
            conn.query_row(
                "SELECT input_version, chunk_count FROM note_embedding_state WHERE note_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(failed)
        })
    }

    fn embeddable(&self) -> Vec<EmbeddableNote> {
        self.data.read_blocking(embeddable).expect("embeddable")
    }

    fn owed(&self) -> Vec<String> {
        let notes = self.embeddable();
        self.index(move |conn| owed(conn, notes))
            .into_iter()
            .map(|note| note.note_id)
            .collect()
    }
}

#[test]
fn markdown_notes_and_days_are_embeddable_with_their_titles() {
    let d = dbs();
    d.file("n1", "b/Plan.md", "markdown", Some("Plan"));
    d.file("day", "journal/2026-01-02.md", "markdown", None);
    d.file("pdf", "a/doc.pdf", "pdf", Some("doc"));
    let notes = d.embeddable();
    let got: Vec<(&str, &str)> = notes
        .iter()
        .map(|n| (n.note_id.as_str(), n.title.as_str()))
        .collect();
    assert_eq!(got, [("n1", "Plan"), ("day", "2026-01-02")]);
    let one = d
        .data
        .read_blocking(|conn| embeddable_note(conn, "pdf"))
        .expect("read");
    assert_eq!(one, None);
}

#[test]
fn store_writes_head_chunks_similar_and_state_in_one_go() {
    let d = dbs();
    d.index(|conn| store(conn, "n1", None, "One", &[v(1.0), v(2.0), v(3.0)], &v(4.0)));
    assert_eq!(d.state("n1"), Some((i64::from(EMBEDDING_INPUT_VERSION), 2)));
    assert_eq!(d.count("SELECT count(*) FROM vec_note_chunks"), 2);
    let (head, similar, second) = d.index(|conn| {
        Ok((
            vector(conn, VecTable::Notes, "n1")?,
            vector(conn, VecTable::NoteSimilar, "n1")?,
            vector(conn, VecTable::NoteChunks, "n1#2")?,
        ))
    });
    assert_eq!(head, Some(v(1.0)));
    assert_eq!(similar, Some(v(4.0)));
    assert_eq!(second, Some(v(3.0)));

    // A shorter note drops the chunks it no longer has.
    d.index(|conn| store(conn, "n1", None, "One", &[v(5.0)], &v(6.0)));
    assert_eq!(d.state("n1"), Some((i64::from(EMBEDDING_INPUT_VERSION), 0)));
    assert_eq!(d.count("SELECT count(*) FROM vec_note_chunks"), 0);
    assert_eq!(d.count("SELECT count(*) FROM vec_notes"), 1);
}

#[test]
fn dirty_keeps_the_old_vectors_until_a_build_replaces_them() {
    let d = dbs();
    d.file("n1", "n1.md", "markdown", Some("One"));
    d.index(|conn| store(conn, "n1", None, "One", &[v(1.0), v(2.0)], &v(3.0)));
    assert!(d.owed().is_empty());
    d.index(|conn| mark_dirty(conn, "n1"));
    assert_eq!(d.state("n1"), Some((0, 1)));
    assert_eq!(d.count("SELECT count(*) FROM vec_notes"), 1);
    assert_eq!(d.owed(), ["n1"]);
    // The chunk count kept by the dirty row still finds the old chunk.
    d.index(|conn| store(conn, "n1", None, "One", &[v(4.0)], &v(5.0)));
    assert_eq!(d.count("SELECT count(*) FROM vec_note_chunks"), 0);
}

#[test]
fn owed_lists_notes_with_no_vector_first_then_stale_ones() {
    let d = dbs();
    d.file("a", "a.md", "markdown", Some("A"));
    d.file("b", "b.md", "markdown", Some("B"));
    d.file("c", "c.md", "markdown", Some("C"));
    d.index(|conn| {
        store(conn, "a", None, "A", &[v(1.0)], &v(1.0))?;
        store(conn, "c", None, "C", &[v(1.0)], &v(1.0))?;
        conn.execute(
            "UPDATE note_embedding_state SET input_version = 5 WHERE note_id = 'a'",
            [],
        )
        .map_err(failed)
        .map(drop)
    });
    assert_eq!(d.owed(), ["b", "a"]);
}

#[test]
fn a_note_is_owed_until_its_vectors_were_built_from_the_hash_it_has_now() {
    let d = dbs();
    d.file("n1", "n1.md", "markdown", Some("One"));
    d.hashes("n1", Some("aaaa0001"), None);
    d.index(|conn| store(conn, "n1", Some("aaaa0001"), "One", &[v(1.0)], &v(1.0)));
    assert!(d.owed().is_empty());

    // An edit whose event never reached the lane: only `note_files` moved.
    d.hashes("n1", Some("aaaa0002"), None);
    assert_eq!(d.owed(), ["n1"]);
    // A file the document refused: the hash of the bytes on disk, which the projector reads.
    d.hashes("n1", Some("aaaa0002"), Some("ffff0001"));
    assert_eq!(d.owed(), ["n1"]);
    d.index(|conn| store(conn, "n1", Some("ffff0001"), "One", &[v(2.0)], &v(2.0)));
    assert!(d.owed().is_empty());
    // The write-back puts the document's text back on disk: the vectors hold other bytes.
    d.hashes("n1", Some("aaaa0002"), Some("aaaa0002"));
    assert_eq!(d.owed(), ["n1"]);
    d.index(|conn| store(conn, "n1", Some("aaaa0002"), "One", &[v(2.0)], &v(2.0)));
    // A file the tier never read: no hash on either side.
    d.hashes("n1", None, None);
    assert_eq!(d.owed(), ["n1"]);
    d.index(|conn| store(conn, "n1", None, "One", &[v(3.0)], &v(3.0)));
    assert!(d.owed().is_empty());
}

#[test]
fn a_note_is_owed_until_its_vectors_were_built_with_the_title_it_has_now() {
    let d = dbs();
    d.file("n1", "n1.md", "markdown", Some("One"));
    d.hashes("n1", Some("aaaa0001"), Some("aaaa0001"));
    d.index(|conn| store(conn, "n1", Some("aaaa0001"), "One", &[v(1.0)], &v(1.0)));
    assert!(d.owed().is_empty());

    // A rename whose event never reached the lane: only the title moved.
    d.data
        .call_blocking(|conn| {
            conn.execute("UPDATE notes SET title = 'Renamed' WHERE id = 'n1'", [])
                .map_err(failed)
        })
        .expect("rename");
    assert_eq!(d.owed(), ["n1"]);
    d.index(|conn| store(conn, "n1", Some("aaaa0001"), "Renamed", &[v(2.0)], &v(2.0)));
    assert!(d.owed().is_empty());
}

#[test]
fn vectors_from_before_the_hashes_are_owed_and_kept() {
    let d = dbs();
    d.file("n1", "n1.md", "markdown", Some("One"));
    d.hashes("n1", Some("aaaa0001"), None);
    d.index(|conn| {
        store(conn, "n1", Some("aaaa0001"), "One", &[v(1.0)], &v(1.0))?;
        conn.execute("DELETE FROM note_embedding_hashes", [])
            .map_err(failed)
            .map(drop)
    });
    assert_eq!(d.owed(), ["n1"]);
    assert_eq!(d.count("SELECT count(*) FROM vec_notes"), 1);
    assert_eq!(d.state("n1"), Some((i64::from(EMBEDDING_INPUT_VERSION), 0)));
}

#[test]
fn prune_drops_everything_a_gone_note_owned() {
    let d = dbs();
    d.file("kept", "kept.md", "markdown", Some("Kept"));
    d.index(|conn| {
        store(conn, "kept", None, "Kept", &[v(1.0)], &v(1.0))?;
        store(conn, "gone", None, "Gone", &[v(1.0), v(2.0)], &v(1.0))?;
        mark_dirty(conn, "dirty-gone")
    });
    let live: HashSet<String> = d.embeddable().into_iter().map(|n| n.note_id).collect();
    assert_eq!(d.index(move |conn| prune(conn, &live)), 2);
    assert_eq!(d.count("SELECT count(*) FROM vec_notes"), 1);
    assert_eq!(d.count("SELECT count(*) FROM vec_note_similar"), 1);
    assert_eq!(d.count("SELECT count(*) FROM vec_note_chunks"), 0);
    assert_eq!(d.count("SELECT count(*) FROM note_embedding_state"), 1);
    assert_eq!(d.count("SELECT count(*) FROM note_embedding_hashes"), 1);
}

#[test]
fn delete_and_clear_leave_no_row() {
    let d = dbs();
    d.index(|conn| {
        store(conn, "a", None, "A", &[v(1.0), v(2.0)], &v(1.0))?;
        store(conn, "b", None, "B", &[v(1.0)], &v(1.0))?;
        delete(conn, "a")
    });
    assert_eq!(d.state("a"), None);
    assert_eq!(d.count("SELECT count(*) FROM vec_note_chunks"), 0);
    assert_eq!(d.count("SELECT count(*) FROM note_embedding_hashes"), 1);
    d.index(clear);
    assert_eq!(d.count("SELECT count(*) FROM vec_notes"), 0);
    assert_eq!(d.count("SELECT count(*) FROM note_embedding_state"), 0);
    assert_eq!(d.count("SELECT count(*) FROM note_embedding_hashes"), 0);
}
