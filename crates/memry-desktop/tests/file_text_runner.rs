//! The file text runner (#3542 lane G) on a real vault (`file_text_env.rs`). The PDF reader and
//! OCR are fakes: the real worker runs in `file_text_worker.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::domain::file_text::{FileTextJobStatus, TextSource};
use memry_desktop::services::file_text::{PdfPages, PdfReader};

use crate::file_text_env::{Ft, ft_with, ft_without_ocr, own};

/// Pages by file name: `Ok(text layer)` or `Err` for a page the worker fails on.
#[derive(Default)]
pub struct FakePdf {
    pub pages: Mutex<HashMap<String, Vec<Result<String, String>>>>,
    pub opens: AtomicUsize,
    /// Every `page_text` call, as `(file, page)`.
    pub reads: Mutex<Vec<(String, u32)>>,
    pub released: AtomicUsize,
    pub renders: AtomicUsize,
    /// `open` and `release`, in order.
    pub events: Mutex<Vec<&'static str>>,
    /// Runs inside each `open` with the open's number, from 1.
    #[allow(clippy::type_complexity)]
    pub on_open: Mutex<Option<Box<dyn Fn(usize) + Send>>>,
}

struct FakeDoc<'a> {
    pdf: &'a FakePdf,
    name: String,
    pages: Vec<Result<String, String>>,
}

impl PdfReader for FakePdf {
    fn open(&self, path: &Path) -> Result<Box<dyn PdfPages + '_>, String> {
        let opened = self.opens.fetch_add(1, Ordering::SeqCst) + 1;
        self.events.lock().unwrap().push("open");
        if let Some(hook) = &*self.on_open.lock().unwrap() {
            hook(opened);
        }
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
        self.events.lock().unwrap().push("release");
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
        self.pdf.renders.fetch_add(1, Ordering::SeqCst);
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

    for _ in 0..3 {
        assert_eq!(f.rescanned(), FILES, "each scan compares each file once");
    }
    assert_eq!(
        open.search
            .file_text_jobs_with_status(FileTextJobStatus::Failed)
            .unwrap(),
        jobs,
        "no job written"
    );
}

/// Without OCR a page with no text layer is stored unreadable and does not stop the read, so
/// the text-layer pages after a run of blank or scanned ones are searchable. The job fails, so
/// the app-version retry reads it again once a build has OCR.
#[test]
fn blank_pages_without_ocr_do_not_stop_the_read() {
    let f = ft_without_ocr(&[("scan.pdf", b"%PDF")], Arc::new(FakePdf::default()));
    f.pdf.pages.lock().unwrap().insert(
        "scan.pdf".into(),
        pages(&[Ok(""), Ok(" "), Ok(""), Ok("Zebra four")]),
    );
    f.scanned();
    let of = own(&f.id_of("scan.pdf"));
    let job = f.settled_job(&of);
    assert_eq!(
        (job.status, job.error.as_deref()),
        (FileTextJobStatus::Failed, Some("OCR unavailable"))
    );
    assert_eq!(f.found("Zebra"), std::slice::from_ref(&of.note_id));
    assert_eq!(f.pdf.renders.load(Ordering::SeqCst), 0, "nothing rendered");
    assert_eq!(f.pdf.opens.load(Ordering::SeqCst), 1);
}

/// A rescan forgets the finished jobs and text of a note that is gone, not only its pending
/// ones (Electron's `note_cache` cascade).
#[test]
fn a_rescan_drops_the_finished_jobs_of_a_gone_note() {
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
    open.search
        .finish_file_text(
            ghost.clone(),
            memry_core::domain::file_text::JobOutcome::Done,
            Some("eng".into()),
        )
        .unwrap();
    f.scanned();
    assert_eq!(f.job(&ghost), None);
    assert_eq!(f.text("ghost"), "");
}

/// Without OCR an image is not read at all: its job fails `OCR unavailable` at once.
#[test]
fn an_image_without_ocr_is_not_read_and_fails_for_the_retry() {
    let f = ft_without_ocr(&[("scan.png", b"png bytes")], Arc::new(FakePdf::default()));
    f.scanned();
    let of = own(&f.id_of("scan.png"));
    let job = f.settled_job(&of);
    assert_eq!(
        (job.status, job.error.as_deref(), job.page_count),
        (FileTextJobStatus::Failed, Some("OCR unavailable"), Some(1))
    );
    assert_eq!(f.text(&of.note_id), "");
}

/// A stop that lands while a failed page's document is opened again: that open started a new
/// worker child after the stop released the last one, so the runner releases it too.
#[test]
fn a_stop_during_a_page_retry_releases_the_worker_it_opened() {
    let f = ft(&[("doc.pdf", b"%PDF")]);
    f.pdf
        .pages
        .lock()
        .unwrap()
        .insert("doc.pdf".into(), pages(&[Err("x"), Ok("two")]));
    let file_text = Arc::downgrade(&f.file_text);
    *f.pdf.on_open.lock().unwrap() = Some(Box::new(move |opened| {
        if opened == 2
            && let Some(runner) = file_text.upgrade().and_then(|file_text| file_text.runner())
        {
            runner.stop();
        }
    }));
    // The first scan runs on open; a stopped runner scans no more.
    f.until("the retry's child released", |f| {
        f.pdf.released.load(Ordering::SeqCst) >= 2
    });
    let events = f.pdf.events.lock().unwrap().clone();
    assert_eq!(
        events,
        ["open", "open", "release", "release"],
        "the retry's child is released"
    );
}

/// Without OCR nothing changes in a day, so the day-old retry would fail the job again; the
/// app-version retry still reads it once a build has OCR.
#[test]
fn a_job_failed_for_want_of_ocr_is_not_retried_after_a_day() {
    let f = ft_without_ocr(&[("scan.png", b"png bytes")], Arc::new(FakePdf::default()));
    f.scanned();
    let of = own(&f.id_of("scan.png"));
    let job = f.settled_job(&of);
    assert_eq!(job.error.as_deref(), Some("OCR unavailable"));

    f.clock_offset.store(25 * 60 * 60 * 1000, Ordering::SeqCst);
    f.scanned();
    assert_eq!(f.job(&of).unwrap(), job, "not read again");
}
