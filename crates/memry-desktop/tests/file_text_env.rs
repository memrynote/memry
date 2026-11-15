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
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::session::projection::feed;
use memry_desktop::vault::consumer::Applied;

use crate::vault_env::files_too::files_too;
use crate::vault_env::{Env, WAIT, env, indexed};

pub struct Ft<P> {
    pub e: Env,
    pub file_text: Arc<FileText>,
    pub pdf: Arc<P>,
    /// What OCR answers; `None` is a build without OCR.
    pub ocr: Arc<Mutex<Option<String>>>,
    pub languages: Arc<Mutex<Vec<String>>>,
    /// Added to the wall clock the 24 h retry reads.
    pub clock_offset: Arc<AtomicI64>,
    _index: Arc<NoteIndex>,
}

/// A vault with `files` written before it opens, then opened and indexed with the runner
/// registered as `vault_boot` registers it.
pub fn ft_with<P: PdfReader + 'static>(files: &[(&str, &[u8])], pdf: Arc<P>) -> Ft<P> {
    let mut e = env(|store| Some(files_too(store)));
    for (rel, bytes) in files {
        let path = e.vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
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
