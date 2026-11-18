//! Note export (`notes:export-html` of `ipc/notes-handlers.ts:1066-1112`) through
//! `NotesService::export_html`, and `notes:export-pdf` (`:983-1064`) through the print window
//! (`windows::pdf_print`). Every outcome after the input parses resolves as an
//! [`ExportResult`], as Electron's `withErrorHandler` resolves a throw as `{ success: false }`;
//! the renderer tells a cancel from a failure by `code`, never by the localized text.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_desktop::export::sanitize_filename;
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::export::HtmlExport;
use memry_desktop::notes::print::print_document;
use memry_desktop::notes::read;
use memry_desktop::paths::AppPaths;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::{open_vault, service, track};
use crate::shell::pdf::Paper;
use crate::shell::{dialogs, services};
use crate::windows::pdf_print::{self, PdfError};

/// `ExportNoteSchema` (`packages/contracts/src/notes-api.ts`) without its `outputPath`: a
/// webview never names the file to write, so the command always asks the user through the save
/// dialog. `deny_unknown_fields` rejects a call that still carries one (a departure from
/// Electron, whose handler writes to the renderer's `outputPath`). The headless export is
/// [`export_html_to`], reachable in process only.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportNoteInput {
    pub note_id: String,
    /// On when absent.
    #[serde(default)]
    pub include_metadata: Option<bool>,
    /// The PDF page; the HTML export ignores it.
    #[serde(default)]
    pub page_size: Option<PageSize>,
    /// Off when absent.
    #[serde(default)]
    pub include_task_markers: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
pub enum PageSize {
    A4,
    Letter,
    Legal,
}

/// Why an export wrote nothing; `cancelled` when the user dismissed the save dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportFailure {
    Cancelled,
    NotFound,
    Failed,
}

/// `{ success: true, path }` or `{ success: false, code, error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub code: Option<ExportFailure>,
    /// Localized, for the failure toast.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl ExportResult {
    fn saved(path: String) -> Self {
        Self {
            success: true,
            path: Some(path),
            code: None,
            error: None,
        }
    }

    fn failed(code: ExportFailure, error: String) -> Self {
        Self {
            success: false,
            path: None,
            code: Some(code),
            error: Some(error),
        }
    }
}

fn text<R: Runtime>(app: &AppHandle<R>, key: &str) -> String {
    let locale = app.state::<Arc<LocaleService>>().get();
    i18n::t(locale, key, &Args::new())
}

/// `notes:export-html`: the note as a self-contained HTML file where the save dialog says.
// Generic over the runtime so a test drives it on a mock app (`tests/notes_export.rs`).
#[tauri::command]
#[specta::specta]
pub async fn notes_export_html<R: Runtime>(
    app: AppHandle<R>,
    input: ExportNoteInput,
) -> Result<ExportResult, CommandError> {
    blocking("notes_export_html", move || {
        Ok(resolve(export_html(&app, input, |title| {
            dialogs::save_file(
                &app,
                &text(&app, "system:dialog.exportHtml.title"),
                &format!("{}.html", sanitize_filename(title)),
                (
                    &text(&app, "system:dialog.exportHtml.filterName"),
                    &["html", "htm"],
                ),
            )
        })))
    })
    .await
}

/// The headless export: the note at `target`, with no dialog. In-process only (tests and the
/// agent API's future port); it is not a command, so no webview reaches it.
pub fn export_html_to<R: Runtime>(
    app: &AppHandle<R>,
    input: ExportNoteInput,
    target: &Path,
) -> ExportResult {
    resolve(export_html(app, input, |_| Some(target.to_path_buf())))
}

fn resolve(outcome: Result<ExportResult, CommandError>) -> ExportResult {
    outcome.unwrap_or_else(|error| {
        log_failure("notes_export_html", &error);
        ExportResult::failed(ExportFailure::Failed, error.message)
    })
}

/// `choose` names the file from the note's title, or `None` for a cancel.
fn export_html<R: Runtime>(
    app: &AppHandle<R>,
    input: ExportNoteInput,
    choose: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<ExportResult, CommandError> {
    // The open vault is not held across the save dialog: a reopen of the same vault meanwhile
    // would fail while this call kept it.
    let (vault_id, note) = {
        let open = open_vault(app)?;
        let telemetry = services::telemetry(app);
        let note = read::get(&open, &input.note_id, telemetry.as_deref())
            .map_err(|error| CommandError::from_core(&error))?;
        (open.vault_id, note)
    };
    let Some(note) = note else {
        return Ok(ExportResult::failed(
            ExportFailure::NotFound,
            text(app, "system:error.noteNotFound"),
        ));
    };
    let Some(target) = choose(&note.title) else {
        return Ok(ExportResult::failed(
            ExportFailure::Cancelled,
            text(app, "system:dialog.exportCancelled"),
        ));
    };
    let export = HtmlExport {
        include_metadata: input.include_metadata.unwrap_or(true),
        include_task_markers: input.include_task_markers.unwrap_or(false),
    };
    let open = open_vault(app)?;
    if open.vault_id != vault_id {
        return Ok(ExportResult::failed(
            ExportFailure::Failed,
            text(app, "system:dialog.exportVaultChanged"),
        ));
    }
    let paths = app.state::<AppPaths>();
    service(app)?
        .export_html(&open, &note, export, &paths.data_dir, &target)
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "export_failed", error.to_string())
        })?;
    track(app, "note_exported", "html");
    Ok(ExportResult::saved(target.to_string_lossy().into_owned()))
}

/// What a failed print tells the user; the engine's text goes to the log only.
const PDF_FAILED: &str = "errors:note.exportPdfFailed";

/// `notes:export-pdf`: the note printed in a hidden window with the page size asked for, written
/// to `outputPath` or where the save dialog says.
#[tauri::command]
#[specta::specta]
pub async fn notes_export_pdf(
    app: AppHandle<Wry>,
    input: ExportNoteInput,
) -> Result<ExportResult, CommandError> {
    Ok(export_pdf(&app, input).await.unwrap_or_else(|error| {
        log_failure("notes_export_pdf", &error);
        ExportResult::failed(ExportFailure::Failed, error.message)
    }))
}

async fn export_pdf(
    app: &AppHandle<Wry>,
    input: ExportNoteInput,
) -> Result<ExportResult, CommandError> {
    let paper = match input.page_size.unwrap_or(PageSize::A4) {
        PageSize::A4 => Paper::A4,
        PageSize::Letter => Paper::Letter,
        PageSize::Legal => Paper::Legal,
    };
    let document = {
        let app = app.clone();
        off_thread(move || pdf_document(&app, input)).await?
    };
    let (html, target) = match document {
        Ok(document) => document,
        Err(answer) => return Ok(answer),
    };
    let bytes = match pdf_print::print_to_pdf(app, html, paper).await {
        Ok(bytes) => bytes,
        // The engine's text is for the log; the user reads a sentence in their language.
        Err(PdfError(reason)) => {
            log_failure(
                "notes_export_pdf",
                &CommandError::new(ErrorKind::Internal, "print_failed", reason),
            );
            return Ok(ExportResult::failed(
                ExportFailure::Failed,
                text(app, PDF_FAILED),
            ));
        }
    };
    let written = target.clone();
    off_thread(move || {
        std::fs::write(&written, bytes).map_err(|error| {
            CommandError::new(ErrorKind::Internal, "export_failed", error.to_string())
        })
    })
    .await?;
    track(app, "note_exported", "pdf");
    Ok(ExportResult::saved(target.to_string_lossy().into_owned()))
}

/// Blocking work off the async runtime; its error is logged once, by the command.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "task_failed", error.to_string()))?
}

/// The note's print document and the file it goes to, or the answer that ends the export
/// (not found, cancelled, vault changed), as `notes:export-pdf` decides them before printing.
fn pdf_document(
    app: &AppHandle<Wry>,
    input: ExportNoteInput,
) -> Result<Result<(String, PathBuf), ExportResult>, CommandError> {
    let (vault_id, note) = {
        let open = open_vault(app)?;
        let telemetry = services::telemetry(app);
        let note = read::get(&open, &input.note_id, telemetry.as_deref())
            .map_err(|error| CommandError::from_core(&error))?;
        (open.vault_id, note)
    };
    let Some(note) = note else {
        return Ok(Err(ExportResult::failed(
            ExportFailure::NotFound,
            text(app, "system:error.noteNotFound"),
        )));
    };
    let target = match input.output_path {
        Some(path) => PathBuf::from(path),
        None => {
            let chosen = dialogs::save_file(
                app,
                &text(app, "system:dialog.exportPdf.title"),
                &format!("{}.pdf", sanitize_filename(&note.title)),
                (&text(app, "system:dialog.exportPdf.filterName"), &["pdf"]),
            );
            let Some(chosen) = chosen else {
                return Ok(Err(ExportResult::failed(
                    ExportFailure::Cancelled,
                    text(app, "system:dialog.exportCancelled"),
                )));
            };
            chosen
        }
    };
    let export = HtmlExport {
        include_metadata: input.include_metadata.unwrap_or(true),
        include_task_markers: input.include_task_markers.unwrap_or(false),
    };
    let open = open_vault(app)?;
    if open.vault_id != vault_id {
        return Ok(Err(ExportResult::failed(
            ExportFailure::Failed,
            text(app, "system:dialog.exportVaultChanged"),
        )));
    }
    let paths = app.state::<AppPaths>();
    let html = service(app)?.note_html(&open, &note, export, &paths.data_dir);
    Ok(Ok((print_document(html), target)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_print_reads_as_a_sentence_in_the_users_language() {
        assert_eq!(
            i18n::t("en", PDF_FAILED, &Args::new()),
            "Failed to export PDF"
        );
        assert_ne!(
            i18n::t("de", PDF_FAILED, &Args::new()),
            "Failed to export PDF"
        );
    }
}
