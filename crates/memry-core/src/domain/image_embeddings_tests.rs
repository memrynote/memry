//! The store half of Electron's `image-embedding-projector.test.ts`, on a real `index.db` with
//! vec0 and a real `data.db`.

use super::*;
use crate::domain::file_text::{
    ExtractedTextMethod, JobOutcome, TextSource, finish, reset_file, save_part, set_page_count,
};
use crate::storage::test_support::temp_dir;
use crate::storage::vec::{EMBEDDING_DIMENSION, vector};
use crate::storage::{Db, open_data, open_index};

struct Dbs {
    _dir: crate::storage::test_support::TempDir,
    data: Db,
    index: Db,
}

fn dbs() -> Dbs {
    let dir = temp_dir("image-embeddings");
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

/// The desktop's rule: PDFs, and raster images but not SVG.
fn classify(name: &str) -> Option<ImageFile> {
    let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase())?;
    match ext.as_str() {
        "pdf" => Some(ImageFile::Pdf),
        "png" | "jpg" | "webp" => Some(ImageFile::Image),
        _ => None,
    }
}

fn of(note_id: &str, source: &str) -> TextSource {
    TextSource {
        note_id: note_id.to_owned(),
        source: source.to_owned(),
    }
}

impl Dbs {
    fn file(&self, id: &str, path: &str, file_type: &str) {
        let (id, path, file_type) = (id.to_owned(), path.to_owned(), file_type.to_owned());
        self.data
            .call_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO note_files (note_id, path, file_type, indexed_at) \
                     VALUES (?1, ?2, ?3, 1)",
                    params![id, path, file_type],
                )
                .map(drop)
                .map_err(failed)
            })
            .unwrap();
    }

    /// A job for `source`, finished unless `pending`, with `pages` and the text of each part.
    fn job(&self, source: TextSource, pending: bool, pages: Option<u32>, texts: &[(u32, &str)]) {
        let texts: Vec<(u32, String)> = texts.iter().map(|(p, t)| (*p, (*t).to_owned())).collect();
        self.index
            .call_blocking(move |conn| {
                reset_file(conn, &source, "10:20", "1.0.0", 0)?;
                if let Some(pages) = pages {
                    set_page_count(conn, &source, pages)?;
                }
                for (part, text) in texts {
                    save_part(conn, &source, part, ExtractedTextMethod::Ocr, &text)?;
                }
                if !pending {
                    finish(conn, &source, &JobOutcome::Done, None, 0)?;
                }
                Ok(())
            })
            .unwrap();
    }

    fn sources(&self, note_ids: Option<&[&str]>) -> Vec<ImageSource> {
        let ids = note_ids.map(|ids| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>());
        let jobs = self
            .index
            .read_blocking(move |conn| jobs(conn, ids.as_deref()))
            .unwrap();
        let ids: Vec<String> = jobs.iter().map(|job| job.note_id.clone()).collect();
        let files = self
            .data
            .read_blocking(move |conn| note_files(conn, &ids))
            .unwrap();
        super::sources(jobs, &files, classify)
    }

    fn rows(&self, sql: &'static str) -> i64 {
        self.index
            .read_blocking(move |conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
            .unwrap()
    }
}

fn v(seed: f32) -> Vec<f32> {
    (0..EMBEDDING_DIMENSION)
        .map(|i| seed + i as f32 / 1000.0)
        .collect()
}

#[test]
fn a_filed_image_and_an_attachment_are_listed_with_their_text_and_signature() {
    let d = dbs();
    d.file("shot", "Inbox/shot.png", "image");
    d.file("note", "notes/a.md", "markdown");
    d.job(of("shot", ""), false, None, &[(1, "Grüße 🙂")]);
    d.job(of("note", "photo.jpg"), false, None, &[]);

    let got = d.sources(None);
    assert_eq!(got.len(), 2, "{got:?}");
    let note = &got[0];
    assert_eq!(
        (note.source.as_str(), note.path.as_str()),
        ("photo.jpg", "attachments/note/photo.jpg")
    );
    assert_eq!(
        (note.signature.as_str(), note.text.as_str()),
        ("10:20|0", "")
    );
    let shot = &got[1];
    assert_eq!(
        (shot.source.as_str(), shot.path.as_str(), shot.page),
        ("", "Inbox/shot.png", None)
    );
    assert_eq!(shot.text, "Grüße 🙂");
    assert_eq!(shot.signature, "10:20|8", "text length in UTF-16 units");
    assert!(shot.settled && note.settled);
}

#[test]
fn a_pdf_lists_its_first_eight_pages_with_each_page_text() {
    let d = dbs();
    d.file("doc", "papers/long.pdf", "pdf");
    d.file("note", "a.md", "markdown");
    d.job(
        of("doc", ""),
        false,
        Some(12),
        &[(2, "page two"), (9, "page nine")],
    );
    d.job(of("note", "scan.pdf"), false, Some(2), &[]);
    d.job(of("note", "empty.pdf"), false, None, &[]);

    let got = d.sources(None);
    let keys: Vec<(String, Option<u32>, String)> = got
        .iter()
        .map(|s| (image_key(&s.note_id, &s.source), s.page, s.text.clone()))
        .collect();
    let mut want: Vec<(String, Option<u32>, String)> = (1..=8)
        .map(|page| {
            let text = if page == 2 { "page two" } else { "" };
            (format!("doc/#{page}"), Some(page), text.to_owned())
        })
        .collect();
    want.push(("note/scan.pdf#1".into(), Some(1), String::new()));
    want.push(("note/scan.pdf#2".into(), Some(2), String::new()));
    assert_eq!(keys, want);
    assert_eq!(got[1].signature, "10:20|8");
}

#[test]
fn svg_other_files_and_jobs_of_gone_notes_are_left_out() {
    let d = dbs();
    d.file("svg", "logo.svg", "image");
    d.file("note", "a.md", "markdown");
    d.job(of("svg", ""), false, None, &[]);
    d.job(of("note", "page.html"), false, None, &[(1, "html text")]);
    d.job(of("note", "diagram.svg"), false, None, &[]);
    d.job(of("gone", ""), false, None, &[]);
    assert!(d.sources(None).is_empty());
}

#[test]
fn a_pending_job_is_listed_unsettled_and_note_ids_filter() {
    let d = dbs();
    d.file("a", "a.png", "image");
    d.file("b", "b.png", "image");
    d.job(of("a", ""), true, None, &[]);
    d.job(of("b", ""), false, None, &[]);
    let got = d.sources(Some(&["a"]));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].note_id, "a");
    assert!(!got[0].settled);
}

#[test]
fn store_replaces_and_records_the_signature_then_delete_drops_both() {
    let d = dbs();
    let image = |signature: &str| ImageSource {
        note_id: "n".into(),
        source: "scan.pdf#1".into(),
        signature: signature.into(),
        path: "attachments/n/scan.pdf".into(),
        page: Some(1),
        text: String::new(),
        settled: true,
    };
    let first = image("1:1|0");
    d.index
        .call_blocking(move |c| store(c, &first, &v(0.1)))
        .unwrap();
    let second = image("2:2|4");
    d.index
        .call_blocking(move |c| store(c, &second, &v(0.2)))
        .unwrap();

    let (rows, stored) = d
        .index
        .read_blocking(|c| {
            Ok((
                state(c, Some(&["n".to_owned()]))?,
                vector(c, VecTable::Images, "n/scan.pdf#1")?,
            ))
        })
        .unwrap();
    assert_eq!(
        rows,
        [ImageEmbeddingState {
            note_id: "n".into(),
            source: "scan.pdf#1".into(),
            signature: "2:2|4".into(),
            input_version: IMAGE_EMBEDDING_INPUT_VERSION,
        }]
    );
    assert_eq!(stored, Some(v(0.2)));
    assert_eq!(d.rows("SELECT COUNT(*) FROM vec_images"), 1);

    d.index
        .call_blocking(|c| delete(c, &[("n".into(), "scan.pdf#1".into())]))
        .unwrap();
    assert_eq!(d.rows("SELECT COUNT(*) FROM vec_images"), 0);
    assert_eq!(d.rows("SELECT COUNT(*) FROM image_embedding_state"), 0);
}

/// A quit between the two writes of an older build, or a lost state row: the prune drops the
/// half left behind and keeps whole pairs.
#[test]
fn prune_drops_vectors_without_state_and_state_without_vectors() {
    let d = dbs();
    d.index
        .call_blocking(|c| {
            let kept = ImageSource {
                note_id: "kept".into(),
                source: String::new(),
                signature: "s".into(),
                path: "kept.png".into(),
                page: None,
                text: String::new(),
                settled: true,
            };
            store(c, &kept, &v(0.1))?;
            c.execute(
                "INSERT INTO vec_images (image_key, embedding) VALUES ('orphan/', ?1)",
                [to_blob(&v(0.2))],
            )
            .map_err(failed)?;
            c.execute(
                "INSERT INTO image_embedding_state VALUES ('stale', 'x.png', 's', 2)",
                [],
            )
            .map_err(failed)?;
            prune_orphans(c)
        })
        .unwrap();
    assert_eq!(d.rows("SELECT COUNT(*) FROM vec_images"), 1);
    assert_eq!(
        d.rows("SELECT COUNT(*) FROM image_embedding_state WHERE note_id = 'kept'"),
        1
    );
    assert_eq!(d.rows("SELECT COUNT(*) FROM image_embedding_state"), 1);
}
