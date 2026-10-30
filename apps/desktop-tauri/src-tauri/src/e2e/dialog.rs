//! The dialog queue commands. The queue itself is `memry_desktop::e2e::dialog_queue`; the
//! shell's dialog wrapper reads it (`shell/dialogs.rs`).

use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::e2e::dialog_queue::{DialogKind, DialogQueue};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

fn queue<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<DialogQueue>, CommandError> {
    app.try_state::<Arc<DialogQueue>>()
        .map(|queue| queue.inner().clone())
        .ok_or_else(super::disabled)
}

/// Queues the answer for the next dialog of `kind`: the chosen paths, none for a cancel,
/// `["confirm"]` / `["cancel"]` for a `Confirm`, or the button's index for a `Choose`.
#[tauri::command]
pub fn e2e_dialog_queue_push<R: Runtime>(
    app: AppHandle<R>,
    kind: DialogKind,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    if kind == DialogKind::Confirm
        && !matches!(paths.as_slice(), [word] if word == "confirm" || word == "cancel")
        && !paths.is_empty()
    {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "e2e_dialog_answer",
            "a Confirm answer is `confirm` or `cancel`",
        ));
    }
    if kind == DialogKind::Choose
        && !matches!(paths.as_slice(), [word] if ["0", "1", "2"].contains(&word.as_str()))
    {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "e2e_dialog_answer",
            "a Choose answer is the button index `0`, `1` or `2`",
        ));
    }
    queue(&app)?.push(kind, paths.into_iter().map(PathBuf::from).collect());
    Ok(())
}

#[tauri::command]
pub fn e2e_dialog_queue_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    queue(&app)?.clear();
    Ok(())
}
