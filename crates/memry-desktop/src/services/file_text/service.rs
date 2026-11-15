//! The file text runner on the vault lifecycle (`file-text/index.ts`) and its projector
//! (`projections/projectors/file-text-projector.ts:14-31`): one [`FileTextRunner`] per open
//! vault, started with the open and stopped with the close, told by the `file-text` lane which
//! notes to compare again.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use super::PdfReader;
use super::runner::{FileTextRunner, Indexing, NowMs, OcrLanguageCodes, Recognize, RunnerDeps};
use crate::session::projection::{
    CancelToken, NoteProjectionRecord, ProjectionEvent, Projector, feed,
};
use crate::session::{OpenStage, OpenVault, Session};

/// The lane's name.
pub const NAME: &str = "file-text";

/// What the runner of every vault reads with.
pub struct FileTextConfig {
    pub app_version: String,
    pub pdf: Arc<dyn PdfReader>,
    pub recognize: Recognize,
    pub ocr_languages: OcrLanguageCodes,
    pub now_ms: NowMs,
    pub indexing: Indexing,
}

/// OCR comes with the Tesseract engine (#3542 lane F). Until then a scanned page or an image
/// reads as unreadable and its job fails; the app-version retry reads it again once a build
/// has OCR.
pub fn ocr_unavailable() -> Recognize {
    Arc::new(|_| Err("OCR is not available in this build".into()))
}

pub struct FileText {
    config: FileTextConfig,
    session: Session,
    running: Mutex<Option<(Arc<FileTextRunner>, JoinHandle<()>)>>,
}

impl FileText {
    pub fn new(session: &Session, config: FileTextConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            session: session.clone(),
            running: Mutex::new(None),
        })
    }

    /// The `file-text` lane, and the runner on every open and close.
    pub fn register(self: &Arc<Self>) {
        self.session
            .register_projector(Arc::new(FileTextProjector(self.clone())));
        let opening = self.clone();
        self.session.on_open(
            NAME,
            OpenStage::Defaults,
            Arc::new(move |open| {
                opening.start(open);
                Ok(())
            }),
        );
        let closing = self.clone();
        self.session
            .on_close(NAME, Arc::new(move |_| closing.stop()));
    }

    /// The open vault's runner.
    pub fn runner(&self) -> Option<Arc<FileTextRunner>> {
        self.lock().as_ref().map(|(runner, _)| runner.clone())
    }

    /// `fileTextNoteChanged`.
    pub fn note_changed(&self, note_id: &str) {
        if let Some(runner) = self.runner() {
            runner.note_changed(note_id);
        }
    }

    /// The OCR languages changed (`languagesChanged`), or every file is owed a comparison.
    pub fn rescan_all(&self) {
        if let Some(runner) = self.runner() {
            runner.rescan_all();
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<(Arc<FileTextRunner>, JoinHandle<()>)>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn start(&self, open: &OpenVault) {
        self.stop();
        let (search, session) = (open.search.clone(), self.session.clone());
        let runner = FileTextRunner::new(RunnerDeps {
            vault_path: open.path.clone(),
            app_version: self.config.app_version.clone(),
            vault: open.vault.clone(),
            search: open.search.clone(),
            recognize: self.config.recognize.clone(),
            ocr_languages: self.config.ocr_languages.clone(),
            pdf: self.config.pdf.clone(),
            // `textChanged`: the note's search row takes the text (REVIEW-4654), then search
            // and embeddings hear of it.
            text_changed: Arc::new(move |note_id| {
                if let Err(error) = search.refresh_note_text(note_id) {
                    tracing::warn!(scope = "FileText", note_id, %error, "The note's search row did not take its file text");
                }
                feed::publish(
                    &session,
                    ProjectionEvent::NoteTextExtracted {
                        note_id: note_id.to_owned(),
                    },
                );
            }),
            now_ms: self.config.now_ms.clone(),
            indexing: self.config.indexing.clone(),
        });
        match runner.start() {
            Ok(thread) => *self.lock() = Some((runner, thread)),
            Err(error) => {
                tracing::error!(scope = "FileText", %error, "Text extraction did not start");
            }
        }
    }

    /// `stopFileTextExtraction`: before the index database closes.
    fn stop(&self) {
        let Some((runner, thread)) = self.lock().take() else {
            return;
        };
        runner.stop();
        if thread.join().is_err() {
            tracing::error!(scope = "FileText", "The text extraction thread panicked");
        }
    }
}

/// Tells the runner a note was indexed, so it compares that note's files with the bytes its
/// stored text came from. The vault tier's facts (`NoteFileChanged`) carry no kind, so every
/// one is passed on and the runner's lists skip notes with no text-bearing file. A deleted
/// note needs no message: the runner drops the jobs of a note with no `note_files` row.
struct FileTextProjector(Arc<FileText>);

impl Projector for FileTextProjector {
    fn name(&self) -> &str {
        NAME
    }

    fn handles(&self, event: &ProjectionEvent) -> bool {
        match event {
            ProjectionEvent::NoteUpserted(NoteProjectionRecord::Markdown(_))
            | ProjectionEvent::NoteFileChanged { .. } => true,
            ProjectionEvent::NoteUpserted(NoteProjectionRecord::File(file)) => {
                matches!(file.file_type.as_str(), "pdf" | "image")
            }
            _ => false,
        }
    }

    fn project(&self, event: &ProjectionEvent, _: &CancelToken) -> Result<(), String> {
        match event {
            ProjectionEvent::NoteUpserted(record) => self.0.note_changed(record.note_id()),
            ProjectionEvent::NoteFileChanged { note_id } => self.0.note_changed(note_id),
            _ => {}
        }
        Ok(())
    }

    fn rebuild(&self, _: &CancelToken) -> Result<(), String> {
        self.0.rescan_all();
        Ok(())
    }

    fn reconcile(&self, _: &CancelToken) -> Result<(), String> {
        self.0.rescan_all();
        Ok(())
    }
}
