//! Native dialogs over `tauri-plugin-dialog`. Every function blocks until the user answers,
//! so call it from `spawn_blocking` or another worker thread, never from the main thread.
//!
//! In the e2e build with an open gate, each call asks the [`DialogQueue`] first. A spec never
//! opens a native dialog; an empty queue answers as a cancel and logs it, so a forgotten
//! `e2e_dialog_queue_push` fails the spec instead of hanging on a real dialog.

use std::path::{Path, PathBuf};

use memry_desktop::e2e::dialog_queue::DialogKind;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The e2e answer for `kind`, when the queue exists (an open gate in an e2e build).
#[cfg(feature = "e2e")]
fn queued<R: Runtime>(app: &AppHandle<R>, kind: DialogKind) -> Option<Vec<PathBuf>> {
    use tauri::Manager;
    let queue = app.try_state::<std::sync::Arc<memry_desktop::e2e::dialog_queue::DialogQueue>>()?;
    Some(queue.take(kind).unwrap_or_else(|| {
        tracing::warn!(
            ?kind,
            "the e2e dialog queue has no answer; treating it as cancel"
        );
        Vec::new()
    }))
}

#[cfg(not(feature = "e2e"))]
fn queued<R: Runtime>(_app: &AppHandle<R>, _kind: DialogKind) -> Option<Vec<PathBuf>> {
    None
}

fn first(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().next()
}

fn into_path(path: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    path.into_path()
        .inspect_err(|error| {
            tracing::warn!("the dialog returned a path this app cannot use: {error}")
        })
        .ok()
}

/// A folder, or `None` when the user cancelled.
pub fn pick_folder<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    start: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(answer) = queued(app, DialogKind::OpenFolder) {
        return first(answer);
    }
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    dialog.blocking_pick_folder().and_then(into_path)
}

/// Files, or an empty list when the user cancelled.
pub fn pick_files<R: Runtime>(app: &AppHandle<R>, title: &str) -> Vec<PathBuf> {
    if let Some(answer) = queued(app, DialogKind::OpenFile) {
        return answer;
    }
    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_files()
        .map(|files| files.into_iter().filter_map(into_path).collect())
        .unwrap_or_default()
}

/// A file to write, or `None` when the user cancelled.
pub fn save_file<R: Runtime>(app: &AppHandle<R>, title: &str) -> Option<PathBuf> {
    if let Some(answer) = queued(app, DialogKind::SaveFile) {
        return first(answer);
    }
    app.dialog()
        .file()
        .set_title(title)
        .blocking_save_file()
        .and_then(into_path)
}

/// A warning with two buttons. `true` when the user chose `confirm_label`.
pub fn confirm<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    message: &str,
    detail: &str,
    confirm_label: &str,
    cancel_label: &str,
) -> bool {
    if let Some(answer) = queued(app, DialogKind::Confirm) {
        return answer
            .first()
            .is_some_and(|word| word.as_os_str() == "confirm");
    }
    app.dialog()
        .message(if detail.is_empty() {
            message.to_owned()
        } else {
            format!("{message}\n\n{detail}")
        })
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label.to_owned(),
            cancel_label.to_owned(),
        ))
        .blocking_show()
}
