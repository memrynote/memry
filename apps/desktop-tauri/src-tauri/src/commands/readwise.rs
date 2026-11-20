//! The Readwise page (`import:readwise:*` of `ipc/readwise-import-handlers.ts`): status,
//! connect, disconnect, Sync now, options, cancel and the error toast's claim, over the open
//! vault's run service (`shell::readwise`). A failure reaches the user as Electron's sentence
//! (`describeReadwiseError`, `syncReadwiseNow`).

use std::sync::Arc;

use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::readwise::connection::{
    OptionsError, ReadwiseOptionsInput, ReadwiseStatus, Sentence, connect_sentence,
    sync_now_sentence,
};
use memry_desktop::readwise::scheduler::ReadwiseRuns;
use memry_desktop::readwise::slot::ReadwiseSlot;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};

fn locale(app: &AppHandle<Wry>) -> &'static str {
    app.try_state::<Arc<LocaleService>>()
        .map_or("en", |locale| locale.get())
}

fn sentence(app: &AppHandle<Wry>, sentence: Sentence) -> String {
    let locale = locale(app);
    match sentence {
        Sentence::Key(key) => i18n::t(locale, key, &Args::new()),
        Sentence::SyncsOnDevice(name) => {
            let device = name.unwrap_or_else(|| {
                i18n::t(
                    locale,
                    "errors:importer.readwiseAnotherDevice",
                    &Args::new(),
                )
            });
            let args = Args::from([("device".to_owned(), Arg::from(device.as_str()))]);
            i18n::t(locale, "errors:importer.readwiseSyncsOnDevice", &args)
        }
        Sentence::Raw(text) => text,
    }
}

fn failed(command: &'static str, code: &'static str, message: impl Into<String>) -> CommandError {
    let error = CommandError::new(ErrorKind::Internal, code, message);
    log_failure(command, &error);
    error
}

/// `requireVaultPath`: no open vault, no Readwise.
fn runs(app: &AppHandle<Wry>, command: &'static str) -> Result<Arc<ReadwiseRuns>, CommandError> {
    let current = app
        .try_state::<Arc<ReadwiseSlot>>()
        .and_then(|slot| slot.current());
    current.ok_or_else(|| {
        let message = i18n::t(locale(app), "errors:ipc.noVaultOpen", &Args::new());
        let error = CommandError::new(ErrorKind::NotFound, "no_vault_open", message);
        log_failure(command, &error);
        error
    })
}

async fn status_of(
    runs: Arc<ReadwiseRuns>,
    command: &'static str,
) -> Result<ReadwiseStatus, CommandError> {
    blocking(command, move || {
        runs.status_view()
            .map_err(|e| CommandError::new(ErrorKind::Internal, "readwise_status_failed", e))
    })
    .await
}

/// `import:readwise:status`.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_status(app: AppHandle<Wry>) -> Result<ReadwiseStatus, CommandError> {
    status_of(
        runs(&app, "import_readwise_status")?,
        "import_readwise_status",
    )
    .await
}

/// `import:readwise:connect`: checks the pasted token with Readwise, then stores it.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_connect(
    app: AppHandle<Wry>,
    token: String,
) -> Result<ReadwiseStatus, CommandError> {
    const COMMAND: &str = "import_readwise_connect";
    let runs = runs(&app, COMMAND)?;
    runs.connect(token).await.map_err(|error| {
        failed(
            COMMAND,
            "readwise_connect_failed",
            sentence(&app, connect_sentence(&error)),
        )
    })
}

/// `import:readwise:disconnect`: the token and run state go, the notes stay.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_disconnect(app: AppHandle<Wry>) -> Result<(), CommandError> {
    const COMMAND: &str = "import_readwise_disconnect";
    let runs = runs(&app, COMMAND)?;
    blocking(COMMAND, move || {
        runs.disconnect()
            .map_err(|e| CommandError::new(ErrorKind::Internal, "readwise_disconnect_failed", e))
    })
    .await
}

/// `import:readwise:sync-now`: runs now, or joins the scheduled run, and returns when it ends.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_sync_now(app: AppHandle<Wry>) -> Result<(), CommandError> {
    const COMMAND: &str = "import_readwise_sync_now";
    let runs = runs(&app, COMMAND)?;
    match runs.sync_now_async().await {
        Ok(_) => Ok(()),
        Err(error) => Err(failed(
            COMMAND,
            "readwise_sync_failed",
            sentence(&app, sync_now_sentence(&error)),
        )),
    }
}

/// `import:readwise:set-options`: writes the given options, answers the status.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_set_options(
    app: AppHandle<Wry>,
    input: ReadwiseOptionsInput,
) -> Result<ReadwiseStatus, CommandError> {
    const COMMAND: &str = "import_readwise_set_options";
    let runs = runs(&app, COMMAND)?;
    let writer = Arc::clone(&runs);
    blocking(COMMAND, move || {
        writer.set_options(&input).map_err(|error| match error {
            OptionsError::InvalidRoot => {
                CommandError::new(ErrorKind::Invalid, "invalid_root_folder", error.to_string())
            }
            OptionsError::Failed(e) => {
                CommandError::new(ErrorKind::Internal, "readwise_options_failed", e)
            }
        })
    })
    .await?;
    status_of(runs, COMMAND).await
}

/// `import:readwise:cancel`: stops the run in progress at its next book.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_cancel(app: AppHandle<Wry>) -> Result<(), CommandError> {
    runs(&app, "import_readwise_cancel")?.cancel();
    Ok(())
}

/// `import:readwise:ack-error-toast`: `first` once per parked episode.
#[tauri::command]
#[specta::specta]
pub async fn import_readwise_ack_error_toast(app: AppHandle<Wry>) -> Result<bool, CommandError> {
    const COMMAND: &str = "import_readwise_ack_error_toast";
    let runs = runs(&app, COMMAND)?;
    blocking(COMMAND, move || {
        runs.ack_error_toast()
            .map_err(|e| CommandError::new(ErrorKind::Internal, "readwise_status_failed", e))
    })
    .await
}
