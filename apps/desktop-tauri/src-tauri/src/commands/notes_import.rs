//! Files copied into the vault from outside it (`notes:import-files` and
//! `notes:show-import-dialog` of `ipc/notes-handlers.ts`; Step 32h1, #3549), through
//! `memry_desktop::notes::import_files`. A file is read only when the shell staged it from a
//! drop or the import dialog returned it (`memry_desktop::import::source_paths`); any other path
//! refuses the call with `import_path_refused` before a file is read.

use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::import::source_paths::ImportGrants;
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::import_files::{ImportFilesInput, ImportFilesResult, import_folder};
use memry_desktop::shell::drop_stage::DropStaging;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use memry_desktop::vault::file_types::supported_extensions;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{failed, open_vault, service};
use crate::shell::{dialogs, services};
use crate::startup::{self, Stage};

/// `{ canceled, filePaths }` of `notes:show-import-dialog`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportDialogResult {
    pub canceled: bool,
    pub file_paths: Vec<String>,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "import grants", init);
}

/// Manages the import dialog's answers, which `notes_import_files` may read.
pub fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(Arc::new(ImportGrants::default()));
    Ok(())
}

fn grants<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<ImportGrants>, CommandError> {
    app.try_state::<Arc<ImportGrants>>()
        .map(|grants| grants.inner().clone())
        .ok_or_else(|| CommandError::new(ErrorKind::Internal, "import_grants_missing", "no grants"))
}

/// `notes:show-import-dialog`: files to import, from the supported types or any. What it returns
/// is what `notes_import_files` may read next.
#[tauri::command]
#[specta::specta]
pub async fn notes_show_import_dialog(
    app: AppHandle<Wry>,
) -> Result<ImportDialogResult, CommandError> {
    blocking("notes_show_import_dialog", move || {
        let locale = app.state::<Arc<LocaleService>>().get();
        let t = |key: &str| i18n::t(locale, key, &Args::new());
        let supported: Vec<&str> = supported_extensions().collect();
        let picked = dialogs::pick_files_filtered(
            &app,
            &[
                (&t("system:dialog.import.filterSupported"), &supported),
                (&t("system:dialog.import.filterAll"), &["*"]),
            ],
        );
        grants(&app)?.grant(&picked);
        let file_paths: Vec<String> = picked
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        Ok(ImportDialogResult {
            canceled: file_paths.is_empty(),
            file_paths,
        })
    })
    .await
}

/// `notes:import-files`: copies the files into the folder, vault-relative, or the vault's
/// default note folder. One file that fails leaves the others; a path neither dropped nor
/// picked, a folder outside the vault or a locked one refuses the call.
#[tauri::command]
#[specta::specta]
pub async fn notes_import_files<R: Runtime>(
    app: AppHandle<R>,
    input: ImportFilesInput,
) -> Result<ImportFilesResult, CommandError> {
    blocking("notes_import_files", move || {
        let open = open_vault(&app)?;
        // Before the admit, so a refused folder takes no pick of the import dialog.
        let folder =
            import_folder(&open, input.target_folder.as_deref()).map_err(|error| failed(&error))?;
        let staging: PathBuf = app
            .try_state::<Arc<DropStaging>>()
            .map(|staging| staging.root().to_path_buf())
            .unwrap_or_default();
        let sources = grants(&app)?
            .admit(&staging, &input.source_paths)
            .map_err(|refused| {
                CommandError::new(
                    ErrorKind::Invalid,
                    "import_path_refused",
                    refused.to_string(),
                )
            })?;
        let plain = input
            .options
            .and_then(|options| options.plain_checklists)
            .unwrap_or(false);
        let result = service(&app)?.import_files(&open, &folder, sources, plain);
        if let Some(telemetry) = services::telemetry(&app) {
            let mut event = Service::event("note_imported", "notes", "imported");
            event.object_type = Some("note".to_owned());
            event.result = Some(
                if result.failed == 0 {
                    "success"
                } else {
                    "failed"
                }
                .to_owned(),
            );
            event.metrics = Some(Metrics {
                item_count: Some(f64::from(result.imported)),
                ..Metrics::default()
            });
            telemetry.track_main_event(event);
        }
        Ok(result)
    })
    .await
}
