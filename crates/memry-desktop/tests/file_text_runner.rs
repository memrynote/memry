//! The file text runner (#3542 lane G) on a real vault: the tier, the note index and the
//! projection feed run as `vault_boot` runs them, and `index.db` and `data.db` are real SQLite
//! files. The PDF reader and OCR are fakes: the real worker runs in `file_text_worker.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use memry_core::domain::file_text::{FileTextJob, FileTextJobStatus, OWN_FILE, TextSource};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::services::file_text::{PdfPages, PdfReader};
use memry_desktop::session::projection::feed;
use memry_desktop::vault::consumer::Applied;

use crate::vault_env::{Env, WAIT, env, indexed};

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

pub struct Ft {
    pub e: Env,
    pub file_text: Arc<FileText>,
    pub pdf: Arc<FakePdf>,
    /// What OCR answers; `None` is a build without OCR.
    pub ocr: Arc<Mutex<Option<String>>>,
    pub languages: Arc<Mutex<Vec<String>>>,
    /// Added to the wall clock the 24 h retry reads.
    pub clock_offset: Arc<AtomicI64>,
    _index: Arc<NoteIndex>,
}

/// A vault with `files` written before it opens, then opened and indexed with the runner
/// registered as `vault_boot` registers it.
pub fn ft(files: &[(&str, &[u8])]) -> Ft {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    for (rel, bytes) in files {
        let path = e.vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let pdf = Arc::new(FakePdf::default());
    let ocr: Arc<Mutex<Option<String>>> = Arc::default();
    let languages = Arc::new(Mutex::new(vec!["eng".to_owned()]));
    let clock_offset = Arc::new(AtomicI64::new(0));
    let weak: Weak<NoteIndex> = Arc::downgrade(&index);
    let file_text = FileText::new(
        &e.session,
        FileTextConfig {
            app_version: "1.0.0".into(),
            pdf: pdf.clone(),
            recognize: {
                let ocr = ocr.clone();
                Arc::new(move |_| {
                    let ocr = ocr.lock().unwrap().clone();
                    ocr.ok_or_else(|| "OCR is not available in this build".to_owned())
                })
            },
            ocr_languages: {
                let languages = languages.clone();
                Arc::new(move || languages.lock().unwrap().clone())
            },
            now_ms: {
                let offset = clock_offset.clone();
                Arc::new(move || {
                    chrono::Utc::now().timestamp_millis() + offset.load(Ordering::SeqCst)
                })
            },
            indexing: Arc::new(move || {
                weak.upgrade()
                    .is_some_and(|index| index.indexing().is_some())
            }),
        },
    );
    file_text.register();
    feed::watch(&e.session, e.tier.subscribe()).unwrap();
    e.open();
    e.facts_until(indexed);
    Ft {
        e,
        file_text,
        pdf,
        ocr,
        languages,
        clock_offset,
        _index: index,
    }
}

pub fn own(note_id: &str) -> TextSource {
    TextSource {
        note_id: note_id.to_owned(),
        source: OWN_FILE.to_owned(),
    }
}

impl Ft {
    pub fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn id_of(&self, rel: &str) -> String {
        let rows = self.e.rows();
        let row = rows.iter().find(|(_, path)| path == rel);
        row.unwrap_or_else(|| panic!("no row for {rel}: {rows:?}"))
            .0
            .clone()
    }

    pub fn job(&self, of: &TextSource) -> Option<FileTextJob> {
        let open = self.e.session.current().expect("open");
        open.search.file_text_job(of.clone()).unwrap()
    }

    pub fn settled_job(&self, of: &TextSource) -> FileTextJob {
        self.until("the job to end", |ft| {
            ft.job(of)
                .is_some_and(|job| job.status != FileTextJobStatus::Pending)
        });
        self.job(of).unwrap()
    }

    pub fn text(&self, note_id: &str) -> String {
        let open = self.e.session.current().expect("open");
        open.search.extracted_text_for_note(note_id).unwrap()
    }

    /// The notes whose search row matches `word`.
    pub fn found(&self, word: &str) -> Vec<String> {
        let open = self.e.session.current().expect("open");
        let word = word.to_owned();
        open.search
            .index_handle()
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare("SELECT id FROM fts_notes WHERE fts_notes MATCH ?1")
                    .unwrap();
                Ok(statement
                    .query_map([word], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<Vec<String>, _>>()
                    .unwrap())
            })
            .unwrap()
    }

    pub fn compared(&self) -> usize {
        self.file_text.runner().expect("running").compared_files()
    }

    /// Every comparison and job a rescan owes has run: the next rescan's scan started after it,
    /// on the runner's one thread.
    pub fn scanned(&self) {
        let runner = self.file_text.runner().expect("running");
        for _ in 0..2 {
            let before = runner.scans();
            self.file_text.rescan_all();
            self.until("a rescan", |_| runner.scans() > before);
        }
    }

    /// The note `rel`, written now; its id once the tier applied it.
    pub fn write_note(&mut self, rel: &str, text: &str) -> String {
        self.e.write(rel, text);
        let rel = rel.to_owned();
        self.e.facts_until(|f| match f {
            Applied::Added { path, .. } | Applied::Changed { path, .. } => *path == rel,
            _ => false,
        });
        self.id_of(&rel)
    }
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
    assert_eq!(f.found("Kassenbon"), [of.note_id.clone()]);
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
