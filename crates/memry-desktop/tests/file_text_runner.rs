//! The file text runner (#3542 lane G) on a real vault (`file_text_env.rs`). The PDF reader and
//! OCR are fakes: the real worker runs in `file_text_worker.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::domain::file_text::{FileTextJobStatus, TextSource};
use memry_desktop::services::file_text::{PdfPages, PdfReader};

use crate::file_text_env::{Ft, ft_with, own};

/// Pages by file name: `Ok(text layer)` or `Err` for a page the worker fails on.
#[derive(Default)]
pub struct FakePdf {
    pub pages: Mutex<HashMap<String, Vec<Result<String, String>>>>,
    pub opens: AtomicUsize,
    /// Every `page_text` call, as `(file, page)`.
    pub reads: Mutex<Vec<(String, u32)>>,
    pub released: AtomicUsize,
}

struct FakeDoc<'a> {
    pdf: &'a FakePdf,
    name: String,
    pages: Vec<Result<String, String>>,
}

impl PdfReader for FakePdf {
    fn open(&self, path: &Path) -> Result<Box<dyn PdfPages + '_>, String> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let pages = self.pages.lock().unwrap().get(&name).cloned();
        let pages = pages.ok_or_else(|| "not a PDF".to_owned())?;
        Ok(Box::new(FakeDoc {
            pdf: self,
            name,
            pages,
        }))
    }

    fn release(&self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

impl PdfPages for FakeDoc<'_> {
    fn page_count(&self) -> u32 {
        self.pages.len() as u32
    }

    fn page_text(&self, page: u32) -> Result<String, String> {
        self.pdf
            .reads
            .lock()
            .unwrap()
            .push((self.name.clone(), page));
        self.pages[page as usize - 1].clone()
    }

    fn render_page(&self, page: u32, _: u32) -> Result<Vec<u8>, String> {
        Ok(format!("{}#{page}", self.name).into_bytes())
    }

    fn close(self: Box<Self>) -> Result<(), String> {
        Ok(())
    }
}

/// A vault with `files` written before it opens, read with the fake PDF reader.
pub fn ft(files: &[(&str, &[u8])]) -> Ft<FakePdf> {
    ft_with(files, Arc::new(FakePdf::default()))
}

pub fn pages(texts: &[Result<&str, &str>]) -> Vec<Result<String, String>> {
    texts
        .iter()
        .map(|page| page.map(str::to_owned).map_err(str::to_owned))
        .collect()
}

#[test]
fn a_filed_pdf_is_read_page_by_page_into_its_search_row() {
    let f = ft(&[("doc.pdf", b"%PDF two pages")]);
    f.pdf.pages.lock().unwrap().insert(
        "doc.pdf".into(),
        pages(&[Ok("Rechnung  eins"), Ok("Seite zwei")]),
    );
    f.scanned();
    let id = f.id_of("doc.pdf");
    let job = f.settled_job(&own(&id));
    assert_eq!(job.status, FileTextJobStatus::Done);
    assert_eq!(
        (job.page_count, job.ocr_languages.as_deref()),
        (Some(2), Some("eng"))
    );
    assert_eq!(f.text(&id), "Rechnung eins\n\nSeite zwei");
    assert_eq!(f.found("Rechnung"), [id]);
}

#[test]
fn three_unreadable_pages_in_a_row_fail_the_job_and_stop_the_read() {
    let f = ft(&[("bad.pdf", b"%PDF")]);
    f.pdf.pages.lock().unwrap().insert(
        "bad.pdf".into(),
        pages(&[Ok("one"), Err("x"), Err("x"), Err("x"), Ok("five")]),
    );
    f.scanned();
    let job = f.settled_job(&own(&f.id_of("bad.pdf")));
    assert_eq!(job.status, FileTextJobStatus::Failed);
    assert_eq!(
        job.error.as_deref(),
        Some("Pages up to 4 could not be read")
    );
    let reads = f.pdf.reads.lock().unwrap().clone();
    // Each failed page is read twice, the second time from a document opened again.
    let read_pages: Vec<u32> = reads.iter().map(|(_, page)| *page).collect();
    assert_eq!(read_pages, [1, 2, 2, 3, 3, 4, 4]);
    assert_eq!(f.pdf.opens.load(Ordering::SeqCst), 4);
}

#[test]
fn an_image_without_ocr_fails_and_the_day_old_retry_reads_it_again() {
    let f = ft(&[("scan.png", b"png bytes")]);
    f.scanned();
    let of = own(&f.id_of("scan.png"));
    let job = f.settled_job(&of);
    assert_eq!(job.status, FileTextJobStatus::Failed);
    assert_eq!(f.text(&of.note_id), "");

    *f.ocr.lock().unwrap() = Some("Kassenbon  Total".into());
    f.scanned();
    assert_eq!(f.job(&of).unwrap(), job, "not due within the day");

    f.clock_offset.store(25 * 60 * 60 * 1000, Ordering::SeqCst);
    f.scanned();
    let job = f.settled_job(&of);
    assert_eq!(job.status, FileTextJobStatus::Done);
    assert_eq!(f.text(&of.note_id), "Kassenbon Total");
    assert_eq!(f.found("Kassenbon"), [of.note_id]);
}

#[test]
fn a_language_change_reads_only_the_ocr_pages_again() {
    let f = ft(&[("mixed.pdf", b"%PDF")]);
    f.pdf
        .pages
        .lock()
        .unwrap()
        .insert("mixed.pdf".into(), pages(&[Ok("Layer text"), Ok("  ")]));
    *f.ocr.lock().unwrap() = Some("scanned one".into());
    f.scanned();
    let of = own(&f.id_of("mixed.pdf"));
    assert_eq!(f.settled_job(&of).ocr_languages.as_deref(), Some("eng"));
    assert_eq!(f.text(&of.note_id), "Layer text\n\nscanned one");

    *f.ocr.lock().unwrap() = Some("gescannt zwei".into());
    f.languages.lock().unwrap().push("deu".into());
    f.pdf.reads.lock().unwrap().clear();
    f.scanned();
    f.until("the OCR page read again", |f| {
        f.job(&of)
            .is_some_and(|job| job.ocr_languages.as_deref() == Some("eng+deu"))
    });
    assert_eq!(f.text(&of.note_id), "Layer text\n\ngescannt zwei");
    assert_eq!(*f.pdf.reads.lock().unwrap(), [("mixed.pdf".to_owned(), 2)]);
}

#[test]
fn a_job_whose_note_is_gone_is_dropped() {
    let f = ft(&[]);
    let open = f.e.session.current().unwrap();
    let ghost = own("ghost");
    open.search
        .reset_file_text(ghost.clone(), "1:1".into(), "1.0.0".into())
        .unwrap();
    open.search
        .save_extracted_part(
            ghost.clone(),
            1,
            memry_core::domain::file_text::ExtractedTextMethod::PdfText,
            "old".into(),
        )
        .unwrap();
    f.scanned();
    assert_eq!(f.job(&ghost), None);
    assert_eq!(f.text("ghost"), "");
    assert_eq!(f.pdf.opens.load(Ordering::SeqCst), 0);
}

#[test]
fn an_attachment_the_note_drops_leaves_search() {
    let mut f = ft(&[]);
    let id = f.write_note("n.md", "# Note\n\nPlain body.\n");
    let folder = f.e.vault.join("attachments").join(&id);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("page.html"),
        "<html><body><p>Zebra crossing</p><script>hidden()</script></body></html>",
    )
    .unwrap();
    let link = format!("# Note\n\n![page](attachments/{id}/page.html)\n");
    f.write_note("n.md", &link);
    let of = TextSource {
        note_id: id.clone(),
        source: "page.html".into(),
    };
    assert_eq!(f.settled_job(&of).status, FileTextJobStatus::Done);
    f.until("the attachment text in search", |f| {
        f.found("Zebra") == [id.clone()]
    });
    assert_eq!(f.found("hidden"), Vec::<String>::new());

    f.write_note("n.md", "# Note\n\nThe link is gone.\n");
    f.until("the attachment job gone", |f| f.job(&of).is_none());
    f.until("the attachment text out of search", |f| {
        f.found("Zebra").is_empty()
    });
    assert_eq!(f.found("gone"), [id]);
}

#[test]
fn html_over_the_cap_is_never_parsed_nor_retried() {
    let mut f = ft(&[]);
    let id = f.write_note("n.md", "# Note\n");
    let folder = f.e.vault.join("attachments").join(&id);
    std::fs::create_dir_all(&folder).unwrap();
    let big = vec![b'a'; memry_desktop::services::file_text::html::HTML_TEXT_MAX_BYTES + 1];
    std::fs::write(folder.join("big.html"), big).unwrap();
    f.write_note(
        "n.md",
        &format!("# Note\n\n![big](attachments/{id}/big.html)\n"),
    );
    let of = TextSource {
        note_id: id,
        source: "big.html".into(),
    };
    let job = f.settled_job(&of);
    assert_eq!(job.status, FileTextJobStatus::Failed);
    assert_eq!(
        job.error.as_deref(),
        Some("Too large to read (2097153 bytes, limit 2097152)")
    );
    f.clock_offset.store(25 * 60 * 60 * 1000, Ordering::SeqCst);
    f.scanned();
    assert_eq!(f.job(&of).unwrap(), job);
}

/// A cap the file's bytes hit fails it the same way every time: one parse, and the job says why.
#[test]
fn html_past_a_cap_is_parsed_once_and_its_job_keeps_the_reason() {
    let mut f = ft(&[]);
    let id = f.write_note("n.md", "# Note\n");
    let folder = f.e.vault.join("attachments").join(&id);
    std::fs::create_dir_all(&folder).unwrap();
    let deep = "<div>".repeat(memry_desktop::services::file_text::html::MAX_DEPTH + 10);
    std::fs::write(folder.join("deep.html"), deep).unwrap();
    let parses = f.file_text.runner().expect("running").html_parses();
    f.write_note(
        "n.md",
        &format!("# Note\n\n![deep](attachments/{id}/deep.html)\n"),
    );
    let job = f.settled_job(&TextSource {
        note_id: id,
        source: "deep.html".into(),
    });
    assert_eq!(job.status, FileTextJobStatus::Failed);
    assert_eq!(
        job.error.as_deref(),
        Some("the HTML nests more than 512 elements deep")
    );
    assert_eq!(f.file_text.runner().unwrap().html_parses() - parses, 1);
}

#[cfg(unix)]
#[test]
fn an_attachment_linked_outside_the_vault_fails_its_job() {
    let mut f = ft(&[]);
    let id = f.write_note("n.md", "# Note\n");
    // A linked file is not a file to the folder listing (`Dirent.isFile`); a linked folder is.
    let outside = f.e._dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("leak.pdf"), b"%PDF").unwrap();
    f.pdf
        .pages
        .lock()
        .unwrap()
        .insert("leak.pdf".into(), pages(&[Ok("secret words")]));
    std::fs::create_dir_all(f.e.vault.join("attachments")).unwrap();
    std::os::unix::fs::symlink(&outside, f.e.vault.join("attachments").join(&id)).unwrap();
    f.write_note(
        "n.md",
        &format!("# Note\n\n![x](attachments/{id}/leak.pdf)\n"),
    );
    let of = TextSource {
        note_id: id.clone(),
        source: "leak.pdf".into(),
    };
    let job = f.settled_job(&of);
    assert_eq!(job.status, FileTextJobStatus::Failed);
    assert_eq!(job.signature, "outside-vault");
    assert_eq!(
        job.error,
        Some(format!(
            "attachments/{id}/leak.pdf points outside the vault"
        ))
    );
    assert_eq!(f.pdf.opens.load(Ordering::SeqCst), 0);
    assert_eq!(f.text(&id), "");
}

/// A scan with nothing changed compares each file once and writes no job: the step count of a
/// thousand filed images (`pnpm seed1k` size) is the file count.
#[test]
fn a_scan_with_nothing_changed_compares_each_file_once() {
    const FILES: usize = 1000;
    let names: Vec<String> = (0..FILES)
        .map(|i| format!("img/f{}/i{i}.png", i % 10))
        .collect();
    let files: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"png"[..])).collect();
    let f = ft(&files);
    let before_first = f.compared();
    f.scanned();
    let open = f.e.session.current().unwrap();
    f.until("every image read", |_| {
        open.search
            .file_text_jobs_with_status(FileTextJobStatus::Failed)
            .unwrap()
            .len()
            == FILES
    });
    let jobs = open
        .search
        .file_text_jobs_with_status(FileTextJobStatus::Failed)
        .unwrap();
    assert!(f.compared() - before_first >= FILES);

    let before = f.compared();
    f.file_text.rescan_all();
    f.until("one rescan", |f| f.compared() >= before + FILES);
    f.scanned();
    assert_eq!(
        f.compared() - before,
        3 * FILES,
        "each scan compares each file once"
    );
    assert_eq!(
        open.search
            .file_text_jobs_with_status(FileTextJobStatus::Failed)
            .unwrap(),
        jobs,
        "no job written"
    );
}
