//! Reading one job's file: `extract`, `extractPdf`, `readPdfPage`, `ocr` and `readTwice` of
//! `runner.ts:354-560`.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::io::Read as _;
use std::path::Path;
use std::sync::atomic::Ordering;

use memry_core::domain::file_text::{
    ExtractedTextMethod, FileTextJob, JobOutcome, normalize_extracted_text,
};

use super::{
    FILE_SETTLE, FileTextRunner, MAX_CONSECUTIVE_FAILURES, OCR_RENDER_MAX_EDGE, TextFile, TextKind,
    file_signature, is_oversized_html, misses_ocr_language, text,
};
use crate::services::file_text::PdfPages;
use crate::services::file_text::html::{HTML_TEXT_MAX_BYTES, HtmlTextError, read_html_text_until};
use crate::shell::file_open::Resolution;
use crate::vault::paths::{open_vault_file, resolve_vault_file};

/// How a job without OCR ends, so the app-version retry reads its OCR parts once a build has
/// it (#3542 lane F).
const OCR_UNAVAILABLE: &str = "OCR unavailable";

struct PageText {
    method: ExtractedTextMethod,
    text: String,
    /// Unreadable only because this build has no OCR: not a failure of the page.
    ocr_missing: bool,
}

impl PageText {
    fn read(method: ExtractedTextMethod, text: String) -> Self {
        Self {
            method,
            text,
            ocr_missing: false,
        }
    }

    fn unreadable() -> Self {
        Self::read(ExtractedTextMethod::Unreadable, String::new())
    }

    fn without_ocr() -> Self {
        Self {
            ocr_missing: true,
            ..Self::unreadable()
        }
    }

    /// A page read that went wrong, which counts toward [`MAX_CONSECUTIVE_FAILURES`].
    fn failed(&self) -> bool {
        self.method == ExtractedTextMethod::Unreadable && !self.ocr_missing
    }
}

/// How a job saves its parts and ends. A part read again for a new OCR language keeps its old
/// text when the new read fails; the job then fails with its old languages, so it is read again
/// on the failure retry schedule, not on every comparison.
struct Job<'a> {
    runner: &'a FileTextRunner,
    file: &'a TextFile,
    read_with: Option<&'a str>,
    languages: String,
    read_again: BTreeSet<u32>,
    kept_old_text: Cell<bool>,
    ocr_missing: Cell<bool>,
}

impl Job<'_> {
    fn save(&self, part: u32, result: &PageText) -> Result<(), String> {
        if result.ocr_missing {
            self.ocr_missing.set(true);
        }
        if result.method == ExtractedTextMethod::Unreadable && self.read_again.contains(&part) {
            self.kept_old_text.set(true);
            return Ok(());
        }
        self.runner.save_part(self.file, part, result)
    }

    /// `finish(status, error)`: a job that kept old OCR text fails with its old languages.
    fn end(&self, failed: bool, error: Option<String>) -> Result<(), String> {
        let (outcome, languages) = if self.kept_old_text.get() {
            let error = error.unwrap_or_else(|| {
                "OCR text could not be read again with the new languages".into()
            });
            (
                JobOutcome::Failed(Some(error)),
                self.read_with.map(str::to_owned),
            )
        } else if failed {
            (JobOutcome::Failed(error), Some(self.languages.clone()))
        } else if self.ocr_missing.get() {
            (
                JobOutcome::Failed(Some(OCR_UNAVAILABLE.into())),
                Some(self.languages.clone()),
            )
        } else {
            (JobOutcome::Done, Some(self.languages.clone()))
        };
        self.runner
            .deps
            .search
            .finish_file_text(self.file.of.clone(), outcome, languages)
            .map_err(text)
    }

    fn fail(&self, error: String) -> Result<(), String> {
        self.end(true, Some(error))
    }

    /// `finish(result.method === 'unreadable' ? 'failed' : 'done')`.
    fn finish_part(&self, result: &PageText) -> Result<(), String> {
        self.end(result.failed(), None)
    }
}

/// The flush points of a long PDF: pages 1, 2, 4, 8, ... Search sees a long scan fill in as it
/// is read, and the total re-indexing stays within twice the text.
fn is_flush_point(page: u32) -> bool {
    page & (page - 1) == 0
}

/// A vault file's bytes read through the opened file, at most `limit + 1` of them, and its size
/// after the read; a missing or outside file is an error.
fn read_vault_bytes(vault: &Path, rel: &str, limit: Option<u64>) -> Result<(Vec<u8>, u64), String> {
    let file = open_vault_file(vault, rel)
        .map_err(text)?
        .ok_or_else(|| "File not found".to_owned())?;
    let mut bytes = Vec::new();
    match limit {
        Some(limit) => (&file).take(limit + 1).read_to_end(&mut bytes),
        None => (&file).read_to_end(&mut bytes),
    }
    .map_err(text)?;
    let read = bytes.len() as u64;
    let size = file.metadata().map_err(text)?.len();
    Ok((bytes, size.max(read)))
}

impl FileTextRunner {
    fn save_part(&self, file: &TextFile, part: u32, result: &PageText) -> Result<(), String> {
        self.deps
            .search
            .save_extracted_part(file.of.clone(), part, result.method, result.text.clone())
            .map_err(text)
    }

    fn set_page_count(&self, file: &TextFile, count: u32) -> Result<(), String> {
        self.deps
            .search
            .set_file_text_page_count(file.of.clone(), count)
            .map_err(text)
    }

    pub(super) fn extract(&self, file: &TextFile, job: &FileTextJob) -> Result<(), String> {
        let signature = job.signature.as_str();
        let languages = (self.deps.ocr_languages)();
        let read_again = if misses_ocr_language(job.ocr_languages.as_deref(), &languages) {
            self.parts(file, Some(ExtractedTextMethod::Ocr))?
        } else {
            BTreeSet::new()
        };
        let work = Job {
            runner: self,
            file,
            read_with: job.ocr_languages.as_deref(),
            languages: languages.join("+"),
            read_again,
            kept_old_text: Cell::new(false),
            ocr_missing: Cell::new(false),
        };
        let resolved = resolve_vault_file(&self.deps.vault_path, &file.path).map_err(text)?;
        let path = match resolved {
            Resolution::Outside => {
                return work.fail(format!("{} points outside the vault", file.path));
            }
            Resolution::Missing => return work.fail("File not found".into()),
            Resolution::Inside(path) => path,
        };
        let Some(current) = file_signature(&path) else {
            return work.fail("File not found".into());
        };
        if current.signature != signature {
            self.lock().changed.insert(file.of.note_id.clone());
            // Still being written, most likely: let the copy settle before reading.
            self.sleep(FILE_SETTLE);
            return Ok(());
        }
        tracing::debug!(
            scope = "FileText",
            note_id = file.of.note_id,
            attachment = !file.of.source.is_empty(),
            kind = ?file.kind,
            "Reading text"
        );
        match file.kind {
            TextKind::Html => self.extract_html(&work, signature, current.size),
            TextKind::Image => {
                let result = match &self.deps.recognize {
                    None => PageText::without_ocr(),
                    Some(_) => {
                        let Some(result) = self.read_twice(|_| {
                            let (bytes, _) =
                                read_vault_bytes(&self.deps.vault_path, &file.path, None)?;
                            self.ocr(&bytes)
                        }) else {
                            return Ok(());
                        };
                        result
                    }
                };
                if !self.owns(file, signature)? {
                    return Ok(());
                }
                self.set_page_count(file, 1)?;
                work.save(1, &result)?;
                work.finish_part(&result)?;
                self.text_changed(&file.of.note_id);
                Ok(())
            }
            TextKind::Pdf => self.extract_pdf(&work, signature, &path),
        }
    }

    fn extract_html(&self, work: &Job<'_>, signature: &str, size: u64) -> Result<(), String> {
        let file = work.file;
        if is_oversized_html(file, size) {
            self.set_page_count(file, 1)?;
            self.save_part(file, 1, &PageText::unreadable())?;
            work.fail(format!(
                "Too large to read ({size} bytes, limit {HTML_TEXT_MAX_BYTES})"
            ))?;
            self.text_changed(&file.of.note_id);
            return Ok(());
        }
        let text = match self.read_html(file) {
            None => return Ok(()),
            Some(Ok(text)) => text,
            Some(Err(error)) => {
                tracing::warn!(scope = "FileText", note_id = file.of.note_id, %error, "Could not read an HTML file's text");
                if !self.owns(file, signature)? {
                    return Ok(());
                }
                self.set_page_count(file, 1)?;
                self.save_part(file, 1, &PageText::unreadable())?;
                work.fail(error)?;
                self.text_changed(&file.of.note_id);
                return Ok(());
            }
        };
        let result = PageText::read(ExtractedTextMethod::Html, text);
        if !self.owns(file, signature)? {
            return Ok(());
        }
        self.set_page_count(file, 1)?;
        self.save_part(file, 1, &result)?;
        work.finish_part(&result)?;
        self.text_changed(&file.of.note_id);
        Ok(())
    }

    /// `readTwice` for an HTML file, with the error kept for the job: a read that failed is
    /// tried once more, and so is a parse past [`PARSE_DEADLINE`](crate::services::file_text::html::PARSE_DEADLINE) (a busy machine), but a file
    /// over a cap (size, depth, nodes) fails the same way every time and is parsed once. A parse
    /// stops between input chunks once the runner stops. `None` after a stop.
    fn read_html(&self, file: &TextFile) -> Option<Result<String, String>> {
        let mut retried = false;
        loop {
            if self.stopped() {
                return None;
            }
            let limit = HTML_TEXT_MAX_BYTES as u64;
            let outcome = match read_vault_bytes(&self.deps.vault_path, &file.path, Some(limit)) {
                Ok((bytes, size)) if bytes.len() > HTML_TEXT_MAX_BYTES => {
                    // It grew past the cap since it was compared: a cap, so no second read.
                    let size = usize::try_from(size).unwrap_or(usize::MAX);
                    return Some(Err(HtmlTextError::TooLarge { size }.to_string()));
                }
                Ok((bytes, _)) => {
                    let parsed = read_html_text_until(&bytes, &|| self.stopped());
                    self.html_parses.fetch_add(1, Ordering::SeqCst);
                    if self.stopped() {
                        return None;
                    }
                    match parsed {
                        Ok(text) => return Some(Ok(text)),
                        Err(error) => (matches!(error, HtmlTextError::TooSlow), error.to_string()),
                    }
                }
                Err(error) => (true, error),
            };
            match outcome {
                (true, _) if !retried => retried = true,
                (_, error) => return Some(Err(error)),
            }
        }
    }

    fn extract_pdf(&self, work: &Job<'_>, signature: &str, path: &Path) -> Result<(), String> {
        let file = work.file;
        let pdf = match self.deps.pdf.open(path) {
            Ok(pdf) => pdf,
            Err(error) => {
                if self.stopped() || !self.owns(file, signature)? {
                    return Ok(());
                }
                tracing::warn!(scope = "FileText", note_id = file.of.note_id, %error, "Could not open PDF for text extraction");
                return work.fail(error);
            }
        };
        // A stop that came while the worker opened it: `release` ran before this child started.
        if self.stopped() {
            if let Err(error) = pdf.close() {
                tracing::debug!(scope = "FileText", %error, "Closing a PDF failed");
            }
            self.deps.pdf.release();
            return Ok(());
        }
        let mut doc = Some(pdf);
        let outcome = self.read_pages(work, signature, path, &mut doc);
        if let Some(doc) = doc
            && let Err(error) = doc.close()
        {
            tracing::debug!(scope = "FileText", %error, "Closing a PDF failed");
        }
        outcome
    }

    fn read_pages<'a>(
        &'a self,
        work: &Job<'_>,
        signature: &str,
        path: &Path,
        doc: &mut Option<Box<dyn PdfPages + 'a>>,
    ) -> Result<(), String> {
        let file = work.file;
        let page_count = doc.as_ref().map_or(0, |doc| doc.page_count());
        self.set_page_count(file, page_count)?;
        let stored = self.parts(file, None)?;
        let mut failures_in_a_row = 0;
        for page in 1..=page_count {
            if stored.contains(&page) && !work.read_again.contains(&page) {
                continue;
            }
            if self.stopped() || self.rewritten_since(file, signature, path) {
                return Ok(());
            }
            let Some(result) = self.read_twice(|attempt| {
                if attempt > 0 {
                    // A document lives in one worker: after a crash it is opened again.
                    if let Some(old) = doc.take() {
                        let _ = old.close();
                    }
                    *doc = Some(self.deps.pdf.open(path)?);
                    if self.stopped() {
                        return Err("stopped".into());
                    }
                }
                let pdf = doc.as_deref().ok_or("the PDF is not open")?;
                self.read_pdf_page(pdf, page)
            }) else {
                return Ok(());
            };
            if !self.owns(file, signature)? {
                return Ok(());
            }
            work.save(page, &result)?;

            failures_in_a_row = if result.failed() {
                failures_in_a_row + 1
            } else {
                0
            };
            if failures_in_a_row >= MAX_CONSECUTIVE_FAILURES {
                work.fail(format!("Pages up to {page} could not be read"))?;
                self.text_changed(&file.of.note_id);
                return Ok(());
            }
            if is_flush_point(page) {
                self.text_changed(&file.of.note_id);
            }
        }
        work.end(false, None)?;
        self.text_changed(&file.of.note_id);
        Ok(())
    }

    fn read_pdf_page(&self, pdf: &dyn PdfPages, page: u32) -> Result<PageText, String> {
        let layer = normalize_extracted_text(&pdf.page_text(page)?);
        if !layer.is_empty() {
            return Ok(PageText::read(ExtractedTextMethod::PdfText, layer));
        }
        if self.deps.recognize.is_none() {
            return Ok(PageText::without_ocr());
        }
        let png = pdf.render_page(page, OCR_RENDER_MAX_EDGE)?;
        self.ocr(&png)
    }

    fn ocr(&self, image: &[u8]) -> Result<PageText, String> {
        let recognize = self.deps.recognize.as_ref().ok_or(OCR_UNAVAILABLE)?;
        Ok(PageText::read(
            ExtractedTextMethod::Ocr,
            normalize_extracted_text(&recognize(image)?),
        ))
    }

    /// One retry (`read(1)`), because the usual failure is a crashed or timed-out helper that
    /// the second call starts fresh. A stop is not a failure: `None` leaves the page unstored
    /// so the next run reads it.
    fn read_twice(
        &self,
        mut read: impl FnMut(u32) -> Result<PageText, String>,
    ) -> Option<PageText> {
        if let Ok(result) = read(0) {
            return Some(result);
        }
        if self.stopped() {
            return None;
        }
        match read(1) {
            Ok(result) => Some(result),
            Err(_) if self.stopped() => None,
            Err(error) => {
                tracing::warn!(scope = "FileText", %error, "Text extraction gave up on a page");
                Some(PageText::unreadable())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_flush_point;

    #[test]
    fn flush_points_are_the_powers_of_two() {
        let points: Vec<u32> = (1..=20).filter(|page| is_flush_point(*page)).collect();
        assert_eq!(points, [1, 2, 4, 8, 16]);
    }
}
