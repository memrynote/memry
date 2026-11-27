//! The file text runner on a real vault, for `file_text_runner.rs` (a fake PDF reader) and
//! `file_text_worker.rs` (the real worker): the tier, the note index and the projection feed run
//! as `vault_boot` runs them, and `index.db` and `data.db` are real SQLite files.

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use memry_core::domain::file_text::{FileTextJob, FileTextJobStatus, OWN_FILE, TextSource};
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::services::file_text::PdfReader;
use memry_desktop::services::file_text::runner::Recognize;
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::session::projection::feed;
use memry_desktop::vault::consumer::Applied;

use crate::vault_env::files_too::files_too;
use crate::vault_env::{Env, WAIT, env, indexed};

pub struct Ft<P> {
    pub e: Env,
    pub file_text: Arc<FileText>,
    pub pdf: Arc<P>,
    /// What OCR answers; `None` is an OCR call that fails.
    pub ocr: Arc<Mutex<Option<String>>>,
    pub languages: Arc<Mutex<Vec<String>>>,
    /// Added to the wall clock the 24 h retry reads.
    pub clock_offset: Arc<AtomicI64>,
    _index: Arc<NoteIndex>,
}

/// What the runner reads images with.
pub enum Ocr {
    /// A build without OCR.
    Off,
    /// Answers with [`Ft::ocr`].
    Fake,
    Real(Recognize),
}

/// A vault with `files` written before it opens, then opened and indexed with the runner
/// registered as `vault_boot` registers it.
pub fn ft_with<P: PdfReader + 'static>(files: &[(&str, &[u8])], pdf: Arc<P>) -> Ft<P> {
    ft_built(files, pdf, Ocr::Fake, "1.0.0")
}

/// [`ft_with`] in a build without OCR, as the app ships until #3542 lane F.
pub fn ft_without_ocr<P: PdfReader + 'static>(files: &[(&str, &[u8])], pdf: Arc<P>) -> Ft<P> {
    ft_built(files, pdf, Ocr::Off, "1.0.0")
}

pub fn ft_built<P: PdfReader + 'static>(
    files: &[(&str, &[u8])],
    pdf: Arc<P>,
    ocr: Ocr,
    app_version: &str,
) -> Ft<P> {
    let e = env(|store| Some(files_too(store)));
    for (rel, bytes) in files {
        let path = e.vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    opened(e, pdf, ocr, app_version)
}

fn opened<P: PdfReader + 'static>(mut e: Env, pdf: Arc<P>, ocr: Ocr, app_version: &str) -> Ft<P> {
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let answer: Arc<Mutex<Option<String>>> = Arc::default();
    let languages = Arc::new(Mutex::new(vec!["eng".to_owned()]));
    let clock_offset = Arc::new(AtomicI64::new(0));
    let weak: Weak<NoteIndex> = Arc::downgrade(&index);
    let recognize = match ocr {
        Ocr::Off => None,
        Ocr::Real(recognize) => Some(recognize),
        Ocr::Fake => {
            let answer = answer.clone();
            let recognize: Recognize = Arc::new(move |_| {
                let answer = answer.lock().unwrap().clone();
                answer.ok_or_else(|| "OCR failed".to_owned())
            });
            Some(recognize)
        }
    };
    let file_text = FileText::new(
        &e.session,
        FileTextConfig {
            app_version: app_version.into(),
            pdf: pdf.clone(),
            recognize,
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
        ocr: answer,
        languages,
        clock_offset,
        _index: index,
    }
}

impl<P: PdfReader + 'static> Ft<P> {
    /// Closes the vault and opens it again in a new app run, of `app_version` and with `ocr`.
    pub fn restart(self, ocr: Ocr, app_version: &str) -> Self {
        let e = self.e.restart(|store| Some(files_too(store)));
        opened(e, self.pdf, ocr, app_version)
    }
}

pub fn own(note_id: &str) -> TextSource {
    TextSource {
        note_id: note_id.to_owned(),
        source: OWN_FILE.to_owned(),
    }
}

impl<P> Ft<P> {
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

    /// A full scan that began after this call ended; the files it compared.
    pub fn rescanned(&self) -> usize {
        let runner = self.file_text.runner().expect("running");
        let ticket = runner.rescan_all();
        self.until("a rescan", |_| runner.rescanned().ticket >= ticket);
        runner.rescanned().compared
    }

    /// Every comparison and job a rescan owes has run: the next rescan's scan started after it,
    /// on the runner's one thread.
    pub fn scanned(&self) {
        self.rescanned();
        self.rescanned();
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
