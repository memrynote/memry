//! Wires [`DropStaging`] into the app: the staging root under the app data directory, the
//! startup sweep of copies an earlier run never released, the record of the files a native OS
//! drag offers on Linux, and the mapping of its errors.

use std::sync::Arc;
use std::time::SystemTime;

use memry_desktop::paths::AppPaths;
use memry_desktop::shell::drop_stage::{DropStaging, STALE_AFTER, StageError};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

use crate::commands::error::{CommandError, ErrorKind};

/// Staged copies live beside the profile, not in the OS cache directory: `MEMRY_APP_DATA_DIR`
/// then sandboxes them with everything else, so a test run never writes into a real profile.
const STAGING_DIR: &str = "drop-staging";

/// Creates the staging area, manages it, and deletes copies older than a day in the background.
pub fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let root = app.state::<AppPaths>().data_dir.join(STAGING_DIR);
    let staging = Arc::new(DropStaging::new(root));
    app.manage(Arc::clone(&staging));
    tauri::async_runtime::spawn_blocking(move || {
        match staging.sweep(SystemTime::now(), STALE_AFTER) {
            Ok(0) => {}
            Ok(removed) => {
                tracing::info!(scope = "DropStage", removed, "removed stale staged drops");
            }
            Err(error) => {
                tracing::warn!(scope = "DropStage", %error, "could not sweep staged drops");
            }
        }
    });
    Ok(())
}

pub fn stage_error(error: StageError) -> CommandError {
    let (kind, code) = match &error {
        StageError::TooLarge => (ErrorKind::Invalid, "drop_too_large"),
        StageError::TooManyOpen => (ErrorKind::Invalid, "drop_too_many"),
        StageError::TooMuchHeld => (ErrorKind::Invalid, "drop_too_much_held"),
        StageError::UnknownId => (ErrorKind::NotFound, "drop_unknown"),
        StageError::OutOfOrder => (ErrorKind::Invalid, "drop_out_of_order"),
        StageError::Overrun => (ErrorKind::Invalid, "drop_overrun"),
        StageError::Incomplete => (ErrorKind::Invalid, "drop_incomplete"),
        StageError::NotDropped => (ErrorKind::Invalid, "drop_not_dropped"),
        StageError::NotAFile => (ErrorKind::Invalid, "drop_not_a_file"),
        StageError::Io(_) => (ErrorKind::Storage, "drop_io"),
    };
    CommandError::new(kind, code, error.to_string())
}

/// Records the OS drags over `window` for `drop_os_drag_uris` and `drop_stage_os_files`, under the
/// invariant of `os_drag.rs` in memry-desktop. WebKitGTK gives the page a file drag as an empty
/// `text/uri-list` with no `File` objects; the shell reads the URIs off the native drag, which the
/// page cannot forge. Only the main window is watched, so one record serves the app; a second
/// window that takes file drops would key the record by window label.
///
/// - `drag-data-received`: WebKit asks for a drag's data when it enters the view, so this records
///   the drag's files before the page sees `drop`. A drag the app started (a page dragging its own
///   `file://` link, or `setData("text/uri-list")` in `dragstart`) has a source widget in this
///   process; it is never recorded and clears the record.
/// - `drag-drop`: marks the recorded drag dropped. The handler returns `false`, so WebKit's own
///   handler (connected after) still gets the drop. `drag-leave` is no cancel signal: GTK 3 emits
///   it right before `drag-drop`. A cancelled drag stays undropped until the next drag replaces it.
///
/// Each native drag gets an id from the app-wide counter (`next_os_drag_id`), so it never repeats,
/// even after the main window is rebuilt and this runs again. The `GdkDragContext` is held weakly,
/// so a new context at a reused address is still a new drag. Installing starts from no record.
#[cfg(target_os = "linux")]
pub fn watch_os_drags(window: &WebviewWindow<Wry>) {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Instant;

    use gtk::gdk::DragContext;
    use gtk::glib::WeakRef;
    use gtk::prelude::{DragContextExtManual, ObjectExt, WidgetExt};

    #[derive(Default)]
    struct Drags {
        current: Option<(WeakRef<DragContext>, u64)>,
    }

    impl Drags {
        fn id_of(&mut self, context: &DragContext, staging: &DropStaging) -> u64 {
            if let Some((weak, id)) = &self.current
                && weak.upgrade().as_ref() == Some(context)
            {
                return *id;
            }
            let id = staging.next_os_drag_id();
            self.current = Some((context.downgrade(), id));
            id
        }
    }

    let staging = Arc::clone(&window.state::<Arc<DropStaging>>());
    staging.os_drag_cleared();
    let result = window.with_webview(move |webview| {
        let view = webview.inner();
        let drags = Rc::new(RefCell::new(Drags::default()));
        {
            let (staging, drags) = (Arc::clone(&staging), Rc::clone(&drags));
            view.connect_drag_data_received(move |_, context, _, _, data, _, _| {
                if context.drag_get_source_widget().is_some() {
                    staging.os_drag_cleared();
                    return;
                }
                let uris = data.uris();
                // The drag's other targets (`text/html`, text) carry no URI list.
                if !uris.is_empty() {
                    let drag = drags.borrow_mut().id_of(context, &staging);
                    staging.os_drag_offered(drag, &uris);
                }
            });
        }
        view.connect_drag_drop(move |_, context, _, _, _| {
            if context.drag_get_source_widget().is_some() {
                staging.os_drag_cleared();
            } else {
                let drag = drags.borrow_mut().id_of(context, &staging);
                staging.os_drag_dropped(drag, Instant::now());
            }
            false
        });
    });
    if let Err(error) = result {
        tracing::error!(scope = "DropStage", "the webview was not reached: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn watch_os_drags(_window: &WebviewWindow<Wry>) {}
