use std::collections::BTreeSet;

use super::*;
use crate::storage::Db;
use crate::storage::migrations::{INDEX_MIGRATIONS, run};

const T0: i64 = 1_700_000_000_000;

fn index() -> Db {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, INDEX_MIGRATIONS))
        .expect("migrate");
    db
}

fn src(note_id: &str, source: &str) -> TextSource {
    TextSource {
        note_id: note_id.into(),
        source: source.into(),
    }
}

fn parts(conn: &Connection, of: &TextSource, method: Option<ExtractedTextMethod>) -> Vec<u32> {
    parts_for(conn, of, method)
        .expect("parts")
        .into_iter()
        .collect()
}

/// Inputs and outputs of Electron's `normalizeExtractedText`
/// (`database/queries/extracted-text.ts:49-55`), run in place under Node.
#[test]
fn normalize_matches_electron() {
    let cases = [
        ("", ""),
        ("   ", ""),
        ("plain", "plain"),
        ("  a  b\t\tc  ", "a b c"),
        ("a \n b", "a\nb"),
        ("a\n\n\n\nb", "a\n\nb"),
        ("a \n \n \n b", "a\n\nb"),
        ("a\r\nb", "a\nb"),
        ("a\r\n\r\n\r\nb", "a\n\nb"),
        ("\n\n lead and trail \n\n", "lead and trail"),
        ("x\u{a0}\u{2003}y", "x y"),
        ("x\u{85}y", "x\u{85}y"),
        ("\u{feff}x\u{feff}", "x"),
        ("a\u{2028}b", "a b"),
        ("p1\n\np2\n\n\np3", "p1\n\np2\n\np3"),
        ("tab\t\n\tend", "tab\nend"),
        ("a\u{3000}\n\u{3000}b", "a\nb"),
        ("\u{b}\u{c}form", "form"),
    ];
    for (input, expected) in cases {
        assert_eq!(normalize_extracted_text(input), expected, "input {input:?}");
    }
}

#[test]
fn reset_drops_the_old_text_and_queues_the_new_bytes_keeping_ocr_languages() {
    let db = index();
    let pdf = src("n1", OWN_FILE);
    db.call_blocking(|conn| {
        reset_file(conn, &pdf, "10:1", "1.0.0", T0)?;
        save_part(conn, &pdf, 1, ExtractedTextMethod::Ocr, "old")?;
        set_page_count(conn, &pdf, 3)?;
        finish(conn, &pdf, &JobOutcome::Done, Some("eng+deu"), T0 + 1)?;

        reset_file(conn, &pdf, "20:2", "1.1.0", T0 + 2)?;

        assert!(parts(conn, &pdf, None).is_empty());
        let job = job(conn, &pdf)?.expect("job");
        assert_eq!(
            job,
            FileTextJob {
                note_id: "n1".into(),
                source: String::new(),
                signature: "20:2".into(),
                status: FileTextJobStatus::Pending,
                page_count: None,
                error: None,
                app_version: "1.1.0".into(),
                updated_at: "2023-11-14T22:13:20.002Z".into(),
                // Electron's upsert leaves it: the reader compares it with the chosen languages.
                ocr_languages: Some("eng+deu".into()),
            }
        );
        Ok(())
    })
    .expect("run");
}

#[test]
fn retry_drops_only_unreadable_parts_and_requeue_keeps_every_part() {
    let db = index();
    let pdf = src("n1", OWN_FILE);
    db.call_blocking(|conn| {
        reset_file(conn, &pdf, "s", "1.0.0", T0)?;
        save_part(conn, &pdf, 1, ExtractedTextMethod::PdfText, "one")?;
        save_part(conn, &pdf, 2, ExtractedTextMethod::Unreadable, "")?;
        save_part(conn, &pdf, 3, ExtractedTextMethod::Ocr, "three")?;
        finish(
            conn,
            &pdf,
            &JobOutcome::Failed(Some("Pages up to 2 could not be read".into())),
            None,
            T0,
        )?;
        let failed = job(conn, &pdf)?.expect("job");
        assert_eq!(failed.status, FileTextJobStatus::Failed);
        assert_eq!(
            failed.error.as_deref(),
            Some("Pages up to 2 could not be read")
        );
        assert_eq!(
            parts(conn, &pdf, Some(ExtractedTextMethod::Unreadable)),
            vec![2]
        );

        retry(conn, &pdf, "1.1.0", T0 + 5)?;
        assert_eq!(parts(conn, &pdf, None), vec![1, 3]);
        let retried = job(conn, &pdf)?.expect("job");
        assert_eq!(
            (retried.status, retried.error, retried.app_version),
            (FileTextJobStatus::Pending, None, "1.1.0".into())
        );

        finish(conn, &pdf, &JobOutcome::Done, Some("eng"), T0 + 6)?;
        requeue(conn, &pdf, T0 + 7)?;
        assert_eq!(parts(conn, &pdf, None), vec![1, 3]);
        let requeued = job(conn, &pdf)?.expect("job");
        assert_eq!(requeued.status, FileTextJobStatus::Pending);
        assert_eq!(requeued.ocr_languages.as_deref(), Some("eng"));
        Ok(())
    })
    .expect("run");
}

#[test]
fn save_part_replaces_a_part_and_parts_for_filters_by_method() {
    let db = index();
    let img = src("n1", "scan.png");
    db.call_blocking(|conn| {
        save_part(conn, &img, 1, ExtractedTextMethod::Unreadable, "")?;
        save_part(conn, &img, 1, ExtractedTextMethod::Ocr, "read")?;
        assert_eq!(parts(conn, &img, Some(ExtractedTextMethod::Ocr)), vec![1]);
        assert!(parts(conn, &img, Some(ExtractedTextMethod::Unreadable)).is_empty());
        assert_eq!(extracted_text_for_note(conn, "n1")?, "read");
        Ok(())
    })
    .expect("run");
}

#[test]
fn extracted_text_joins_non_empty_parts_own_file_first_in_part_order() {
    let db = index();
    db.call_blocking(|conn| {
        let own = src("n1", OWN_FILE);
        let html = src("n1", "a.html");
        let other = src("n2", OWN_FILE);
        save_part(conn, &html, 1, ExtractedTextMethod::Html, "attached")?;
        save_part(conn, &own, 10, ExtractedTextMethod::PdfText, "ten")?;
        save_part(conn, &own, 2, ExtractedTextMethod::PdfText, "two")?;
        save_part(conn, &own, 3, ExtractedTextMethod::Unreadable, "")?;
        save_part(conn, &other, 1, ExtractedTextMethod::PdfText, "elsewhere")?;
        assert_eq!(
            extracted_text_for_note(conn, "n1")?,
            "two\n\nten\n\nattached"
        );
        assert_eq!(extracted_text_for_note(conn, "gone")?, "");
        Ok(())
    })
    .expect("run");
}

#[test]
fn next_pending_takes_the_oldest_and_jobs_with_status_lists_in_that_order() {
    let db = index();
    db.call_blocking(|conn| {
        reset_file(conn, &src("b", OWN_FILE), "s", "1", T0 + 1)?;
        reset_file(conn, &src("a", "z.html"), "s", "1", T0 + 1)?;
        reset_file(conn, &src("a", "y.html"), "s", "1", T0 + 1)?;
        reset_file(conn, &src("c", OWN_FILE), "s", "1", T0)?;
        finish(conn, &src("c", OWN_FILE), &JobOutcome::Done, None, T0 + 2)?;

        let next = next_pending(conn)?.expect("pending");
        assert_eq!(
            (next.note_id.as_str(), next.source.as_str()),
            ("a", "y.html")
        );
        let pending: Vec<_> = jobs_with_status(conn, FileTextJobStatus::Pending)?
            .into_iter()
            .map(|job| (job.note_id, job.source))
            .collect();
        assert_eq!(
            pending,
            vec![
                ("a".into(), "y.html".into()),
                ("a".into(), "z.html".into()),
                ("b".into(), String::new()),
            ]
        );
        assert_eq!(jobs_with_status(conn, FileTextJobStatus::Done)?.len(), 1);
        assert!(jobs_with_status(conn, FileTextJobStatus::Failed)?.is_empty());
        Ok(())
    })
    .expect("run");
}

#[test]
fn attachment_jobs_leave_out_own_files_and_other_notes() {
    let db = index();
    db.call_blocking(|conn| {
        for (note, source) in [
            ("a", OWN_FILE),
            ("a", "x.html"),
            ("b", "y.png"),
            ("c", "z.pdf"),
        ] {
            reset_file(conn, &src(note, source), "s", "1", T0)?;
        }
        let all: BTreeSet<_> = attachment_jobs(conn, None)?.into_iter().collect();
        assert_eq!(
            all,
            BTreeSet::from([src("a", "x.html"), src("b", "y.png"), src("c", "z.pdf")])
        );
        let some = attachment_jobs(conn, Some(&["a".to_owned(), "c".to_owned()]))?;
        assert_eq!(
            some.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from([src("a", "x.html"), src("c", "z.pdf")])
        );
        Ok(())
    })
    .expect("run");
}

#[test]
fn delete_source_and_delete_notes_forget_jobs_and_text() {
    let db = index();
    db.call_blocking(|conn| {
        for (note, source) in [
            ("a", OWN_FILE),
            ("a", "x.html"),
            ("b", OWN_FILE),
            ("c", OWN_FILE),
        ] {
            let s = src(note, source);
            reset_file(conn, &s, "s", "1", T0)?;
            save_part(conn, &s, 1, ExtractedTextMethod::PdfText, note)?;
        }
        delete_source(conn, &src("a", "x.html"))?;
        assert!(job(conn, &src("a", "x.html"))?.is_none());
        assert!(job(conn, &src("a", OWN_FILE))?.is_some());
        assert_eq!(extracted_text_for_note(conn, "a")?, "a");

        delete_notes(conn, &["a".to_owned(), "b".to_owned()])?;
        assert!(job(conn, &src("a", OWN_FILE))?.is_none());
        assert!(job(conn, &src("b", OWN_FILE))?.is_none());
        assert_eq!(extracted_text_for_note(conn, "a")?, "");
        assert_eq!(extracted_text_for_note(conn, "c")?, "c");
        Ok(())
    })
    .expect("run");
}
