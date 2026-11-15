//! What a scan owes: the files of the given notes, or of every note, compared with their jobs
//! (`queueFiles`, `attachmentFiles` and the retry rules of `runner.ts`).

use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::Ordering;

use memry_core::domain::file_text::{
    ExtractedTextMethod, FileTextJob, FileTextJobStatus, OWN_FILE, TextSource,
};

use super::{
    ATTACHMENTS_DIR, FileTextRunner, OUTSIDE_VAULT, RETRY_FAILED_AFTER_MS, Signature, TextFile,
    TextKind, attachment, attachment_kind, file_signature, is_oversized_html, misses_ocr_language,
    text,
};
use crate::shell::file_open::Resolution;
use crate::vault::note_file::read_note_lossy;
use crate::vault::paths::resolve_vault_file;

impl FileTextRunner {
    /// PDFs, images and HTML files in the attachments folders of the given notes, or of every
    /// note, that the note's body still embeds, and the notes whose body could not be read:
    /// their stored text is left alone.
    fn attachment_files(
        &self,
        ids: Option<&[String]>,
    ) -> Result<(Vec<TextFile>, HashSet<String>), String> {
        let root = self.deps.vault_path.join(ATTACHMENTS_DIR);
        let folders: Vec<String> = match ids {
            Some(ids) => ids.to_vec(),
            None => std::fs::read_dir(&root)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let mut files = Vec::new();
        let mut unread = HashSet::new();
        let notes = self
            .deps
            .vault
            .note_files()
            .markdown_notes(folders)
            .map_err(text)?;
        for (note_id, note_path) in notes {
            if self.stopped() {
                break;
            }
            let candidates: Vec<String> = std::fs::read_dir(root.join(&note_id))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                        .filter_map(|entry| entry.file_name().into_string().ok())
                        .filter(|name| !name.starts_with('.') && attachment_kind(name).is_some())
                        .collect()
                })
                .unwrap_or_default();
            if candidates.is_empty() {
                continue;
            }
            let body = match read_note_lossy(&self.deps.vault_path, &note_path) {
                Ok(Some(note)) => note.raw,
                Ok(None) => {
                    unread.insert(note_id);
                    continue;
                }
                Err(error) => {
                    tracing::warn!(scope = "FileText", note_id, %error, "Could not read a note body to match its attachments");
                    unread.insert(note_id);
                    continue;
                }
            };
            for name in candidates {
                // Every link shape a note uses for its attachments contains this run
                // (`vault/attachment-reference-scan.ts`).
                if body.contains(&format!("{ATTACHMENTS_DIR}/{note_id}/{name}")) {
                    files.push(attachment(&note_id, &name));
                }
            }
        }
        Ok((files, unread))
    }

    /// Queue every file of the given notes, or of every note, whose bytes differ from the ones
    /// its stored text came from, and forget attachments the note no longer has.
    pub(super) fn queue_files(&self, ids: Option<&[String]>) -> Result<(), String> {
        let search = &self.deps.search;
        let filed = self
            .deps
            .vault
            .note_files()
            .filed_text_files(ids.map(<[String]>::to_vec))
            .map_err(text)?;
        let (attachments, unread) = self.attachment_files(ids)?;
        if self.stopped() {
            return Ok(());
        }
        if ids.is_none() {
            self.forget_gone_notes()?;
        }

        let kept: HashSet<&TextSource> = attachments.iter().map(|file| &file.of).collect();
        for job in search
            .attachment_text_jobs(ids.map(<[String]>::to_vec))
            .map_err(text)?
        {
            if unread.contains(&job.note_id) || kept.contains(&job) {
                continue;
            }
            let note_id = job.note_id.clone();
            search.delete_text_source(job).map_err(text)?;
            (self.deps.text_changed)(&note_id);
        }

        let filed = filed.into_iter().map(|file| TextFile {
            of: TextSource {
                note_id: file.note_id,
                source: OWN_FILE.to_owned(),
            },
            path: file.path,
            kind: if file.file_type == "image" {
                TextKind::Image
            } else {
                TextKind::Pdf
            },
        });
        for file in filed.chain(attachments.iter().cloned()) {
            if self.stopped() {
                return Ok(());
            }
            self.compared.fetch_add(1, Ordering::SeqCst);
            let Some(current) = self.current_signature(&file)? else {
                continue;
            };
            let job = search.file_text_job(file.of.clone()).map_err(text)?;
            if let Some(job) = job
                .as_ref()
                .filter(|job| job.signature == current.signature)
            {
                if is_oversized_html(&file, current.size) {
                    continue;
                }
                if self.is_due_for_retry(job, &file)? {
                    search
                        .retry_file_text(file.of.clone(), self.deps.app_version.clone())
                        .map_err(text)?;
                } else if self.is_missing_ocr_language(job, &file)? {
                    search.requeue_file_text(file.of.clone()).map_err(text)?;
                }
                continue;
            }
            search
                .reset_file_text(
                    file.of.clone(),
                    current.signature,
                    self.deps.app_version.clone(),
                )
                .map_err(text)?;
            if job.is_some() {
                (self.deps.text_changed)(&file.of.note_id);
            }
        }
        Ok(())
    }

    /// Every job and part of a note that is gone: Electron's `note_cache` cascade. The gone
    /// notes have no search row to refresh.
    fn forget_gone_notes(&self) -> Result<(), String> {
        let ids = self.deps.search.file_text_note_ids().map_err(text)?;
        if ids.is_empty() {
            return Ok(());
        }
        let gone = self.deps.vault.note_files().gone_notes(ids).map_err(text)?;
        if gone.is_empty() {
            return Ok(());
        }
        self.deps.search.delete_notes_file_text(gone).map_err(text)
    }

    /// A link outside the vault gets a signature of its own, so text an older build read from
    /// it is dropped and `extract` fails the job.
    fn current_signature(&self, file: &TextFile) -> Result<Option<Signature>, String> {
        Ok(
            match resolve_vault_file(&self.deps.vault_path, &file.path).map_err(text)? {
                Resolution::Outside => Some(Signature {
                    signature: OUTSIDE_VAULT.to_owned(),
                    size: 0,
                }),
                Resolution::Inside(path) => file_signature(&path),
                Resolution::Missing => None,
            },
        )
    }

    /// A failed job, or a finished one with parts it could not read, under another app version
    /// or a day after it last ran. An `updated_at` that does not parse is never a day old, as
    /// `Date.parse` gives `NaN`.
    fn is_due_for_retry(&self, job: &FileTextJob, file: &TextFile) -> Result<bool, String> {
        if job.status == FileTextJobStatus::Pending {
            return Ok(false);
        }
        let aged = memry_core::storage::repositories::instants::to_epoch_ms(&job.updated_at)
            .is_some_and(|at| (self.deps.now_ms)() - at >= RETRY_FAILED_AFTER_MS);
        if job.app_version == self.deps.app_version && !aged {
            return Ok(false);
        }
        Ok(job.status == FileTextJobStatus::Failed
            || !self
                .parts(file, Some(ExtractedTextMethod::Unreadable))?
                .is_empty())
    }

    /// A done job with OCR text read before a language was chosen. A failed one waits for its
    /// retry.
    fn is_missing_ocr_language(&self, job: &FileTextJob, file: &TextFile) -> Result<bool, String> {
        Ok(job.status == FileTextJobStatus::Done
            && misses_ocr_language(job.ocr_languages.as_deref(), &(self.deps.ocr_languages)())
            && !self.parts(file, Some(ExtractedTextMethod::Ocr))?.is_empty())
    }

    pub(super) fn parts(
        &self,
        file: &TextFile,
        method: Option<ExtractedTextMethod>,
    ) -> Result<BTreeSet<u32>, String> {
        self.deps
            .search
            .extracted_parts(file.of.clone(), method)
            .map_err(text)
    }
}
