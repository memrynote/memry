//! The text the index read out of files and the jobs that read it ([`file_text`]), for
//! desktop's file text runner, search and embeddings. Not on the FFI surface: iOS reads no
//! file text.

use std::collections::BTreeSet;

use crate::api::errors::StorageError;
use crate::domain::file_text::{
    self, ExtractedTextMethod, FileTextJob, FileTextJobStatus, JobOutcome, TextSource,
};

use super::{Search, now_ms};

impl Search {
    pub fn file_text_job(&self, of: TextSource) -> Result<Option<FileTextJob>, StorageError> {
        self.index
            .read_blocking(move |index| file_text::job(index, &of))
    }

    pub fn file_text_jobs_with_status(
        &self,
        status: FileTextJobStatus,
    ) -> Result<Vec<FileTextJob>, StorageError> {
        self.index
            .read_blocking(move |index| file_text::jobs_with_status(index, status))
    }

    pub fn next_pending_file_text(&self) -> Result<Option<FileTextJob>, StorageError> {
        self.index.read_blocking(file_text::next_pending)
    }

    pub fn attachment_text_jobs(
        &self,
        note_ids: Option<Vec<String>>,
    ) -> Result<Vec<TextSource>, StorageError> {
        self.index
            .read_blocking(move |index| file_text::attachment_jobs(index, note_ids.as_deref()))
    }

    pub fn reset_file_text(
        &self,
        of: TextSource,
        signature: String,
        app_version: String,
    ) -> Result<(), StorageError> {
        self.index.call_blocking(move |index| {
            file_text::reset_file(index, &of, &signature, &app_version, now_ms())
        })
    }

    pub fn retry_file_text(&self, of: TextSource, app_version: String) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::retry(index, &of, &app_version, now_ms()))
    }

    pub fn requeue_file_text(&self, of: TextSource) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::requeue(index, &of, now_ms()))
    }

    pub fn finish_file_text(
        &self,
        of: TextSource,
        outcome: JobOutcome,
        ocr_languages: Option<String>,
    ) -> Result<(), StorageError> {
        self.index.call_blocking(move |index| {
            file_text::finish(index, &of, &outcome, ocr_languages.as_deref(), now_ms())
        })
    }

    pub fn set_file_text_page_count(
        &self,
        of: TextSource,
        page_count: u32,
    ) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::set_page_count(index, &of, page_count))
    }

    pub fn delete_text_source(&self, of: TextSource) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::delete_source(index, &of))
    }

    pub fn delete_notes_file_text(&self, note_ids: Vec<String>) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::delete_notes(index, &note_ids))
    }

    pub fn save_extracted_part(
        &self,
        of: TextSource,
        part: u32,
        method: ExtractedTextMethod,
        text: String,
    ) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| file_text::save_part(index, &of, part, method, &text))
    }

    pub fn extracted_parts(
        &self,
        of: TextSource,
        method: Option<ExtractedTextMethod>,
    ) -> Result<BTreeSet<u32>, StorageError> {
        self.index
            .read_blocking(move |index| file_text::parts_for(index, &of, method))
    }

    pub fn extracted_text_for_note(&self, note_id: &str) -> Result<String, StorageError> {
        self.index
            .read_blocking(|index| file_text::extracted_text_for_note(index, note_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;
    use crate::storage::test_support::temp_dir;

    #[test]
    fn a_part_saved_through_search_reaches_the_index_file() {
        let dir = temp_dir("search-file-text");
        let directory = dir.path().to_str().expect("utf-8").to_owned();
        let data = Db::open_in_memory().expect("data");
        let pdf = TextSource {
            note_id: "n1".into(),
            source: file_text::OWN_FILE.into(),
        };
        {
            let search = Search::over(data.clone(), &directory).expect("search");
            search
                .reset_file_text(pdf.clone(), "1:1".into(), "1.0.0".into())
                .expect("reset");
            search
                .save_extracted_part(
                    pdf.clone(),
                    1,
                    ExtractedTextMethod::PdfText,
                    "Rechnung".into(),
                )
                .expect("save");
            search
                .finish_file_text(pdf.clone(), JobOutcome::Done, None)
                .expect("finish");
        }

        let reopened = Search::over(data, &directory).expect("reopen");
        assert_eq!(
            reopened.extracted_text_for_note("n1").expect("text"),
            "Rechnung"
        );
        let job = reopened.file_text_job(pdf).expect("job").expect("row");
        assert_eq!(job.status, FileTextJobStatus::Done);
        assert!(reopened.next_pending_file_text().expect("next").is_none());
    }
}
