//! Note export (`notes:export-html` of `ipc/notes-handlers.ts:1066-1112`) through
//! `NotesService::export_html`. Every outcome after the input parses resolves as an
//! [`ExportResult`], as Electron's `withErrorHandler` resolves a throw as `{ success: false }`;
//! the renderer tells a cancel from a failure by `code`, never by the localized text.

use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::export::sanitize_filename;
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::export::HtmlExport;
use memry_desktop::notes::read;
use memry_desktop::paths::AppPaths;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::{open_vault, service, track};
use crate::shell::{dialogs, services};

/// `ExportNoteSchema` (`packages/contracts/src/notes-api.ts`).
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
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
    /// Written without a save dialog (the agent API's headless export).
    #[serde(default)]
    pub output_path: Option<String>,
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

/// `notes:export-html`: the note as a self-contained HTML file at `outputPath`, or where the
/// save dialog says.
// Generic over the runtime so a test drives it on a mock app (`tests/notes_export.rs`).
#[tauri::command]
#[specta::specta]
pub async fn notes_export_html<R: Runtime>(
    app: AppHandle<R>,
    input: ExportNoteInput,
) -> Result<ExportResult, CommandError> {
    blocking("notes_export_html", move || {
        Ok(export_html(&app, input).unwrap_or_else(|error| {
            log_failure("notes_export_html", &error);
            ExportResult::failed(ExportFailure::Failed, error.message)
        }))
    })
    .await
}

fn export_html<R: Runtime>(
    app: &AppHandle<R>,
    input: ExportNoteInput,
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
    let target = match input.output_path {
        Some(path) => PathBuf::from(path),
        None => {
            let chosen = dialogs::save_file(
                app,
                &text(app, "system:dialog.exportHtml.title"),
                &format!("{}.html", sanitize_filename(&note.title)),
                (
                    &text(app, "system:dialog.exportHtml.filterName"),
                    &["html", "htm"],
                ),
            );
            let Some(chosen) = chosen else {
                return Ok(ExportResult::failed(
                    ExportFailure::Cancelled,
                    text(app, "system:dialog.exportCancelled"),
                ));
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
