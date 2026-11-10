use crate::commands::error::{CommandError, ErrorKind};

fn failure(error: arboard::Error) -> CommandError {
    CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string())
}

/// `None` when the clipboard holds no text.
#[tauri::command]
pub async fn e2e_clipboard_read() -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(failure)?;
        match clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(failure(error)),
        }
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))?
}

/// Puts `text` on the clipboard as a copy in the page does. On Linux that makes the app's GTK main
/// loop the owner, so a read on the main thread waits on itself (`shell::clipboard`).
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn e2e_clipboard_write(
    app: tauri::AppHandle<tauri::Wry>,
    text: String,
) -> Result<(), CommandError> {
    let (done, written) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(&text);
        done.send(()).ok();
    })
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))?;
    written
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))
}

/// Puts `text` on the clipboard.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn e2e_clipboard_write(text: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(failure)
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))?
}

/// Pastes into the main window's focused element as Cmd/Ctrl+V does. WebDriver keys are synthetic
/// and paste nothing, so this runs the webview's own paste command: the page's paste event then
/// carries what the OS clipboard holds, the webview's custom types included.
#[tauri::command]
pub async fn e2e_webview_paste(app: tauri::AppHandle<tauri::Wry>) -> Result<(), CommandError> {
    let window = crate::windows::registry::WindowRegistry::main_window(&app)
        .ok_or_else(|| CommandError::new(ErrorKind::Internal, "e2e_clipboard", "no main window"))?;
    let (done, pasted) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| paste(webview, done))
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string())
        })?;
    pasted
        .await
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string())
        })?
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error))
}

/// Runs the paste and resolves `done` once the webview has taken it.
type PasteDone = tokio::sync::oneshot::Sender<Result<(), String>>;

#[cfg(target_os = "macos")]
fn paste(webview: tauri::webview::PlatformWebview, done: PasteDone) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // SAFETY: `inner` is the live WKWebView, used on the main thread that `with_webview` runs on;
    // `paste:` is the responder action the Edit menu's Paste sends.
    unsafe {
        let view = &*webview.inner().cast::<AnyObject>();
        let _: () = msg_send![view, paste: None::<&AnyObject>];
    }
    done.send(Ok(())).ok();
}

#[cfg(target_os = "linux")]
fn paste(webview: tauri::webview::PlatformWebview, done: PasteDone) {
    use webkit2gtk::WebViewExt;

    webview.inner().execute_editing_command("Paste");
    done.send(Ok(())).ok();
}

/// The key events of a Ctrl+V press whose `rawKeyDown` runs the `paste` editing command.
#[cfg(windows)]
static PASTE_KEYS: [&str; 2] = [
    r#"{"type":"rawKeyDown","modifiers":2,"key":"v","code":"KeyV","windowsVirtualKeyCode":86,"commands":["paste"]}"#,
    r#"{"type":"keyUp","modifiers":2,"key":"v","code":"KeyV","windowsVirtualKeyCode":86}"#,
];

/// `done` is shared by the completion handlers and the call sites, which all run on the main
/// thread; whichever finishes the run first takes it.
#[cfg(windows)]
type SharedDone = std::rc::Rc<std::cell::Cell<Option<PasteDone>>>;

#[cfg(windows)]
fn finish(done: &SharedDone, result: Result<(), String>) {
    if let Some(sender) = done.take() {
        sender.send(result).ok();
    }
}

/// Sends `keys` in order, each once WebView2 has completed the one before, and resolves `done`
/// after the last completes. A failed call, or a completion with a failed HRESULT, resolves it
/// with that error.
#[cfg(windows)]
fn send_keys(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    keys: &'static [&'static str],
    done: SharedDone,
) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    const METHOD: &str = "Input.dispatchKeyEvent";
    let Some((params, rest)) = keys.split_first() else {
        finish(&done, Ok(()));
        return;
    };
    let (next_core, next_done) = (core.clone(), done.clone());
    let handler =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, reply| {
            match result {
                Ok(()) => send_keys(next_core, rest, next_done),
                Err(error) => finish(&next_done, Err(format!("{METHOD}: {error} {reply}"))),
            }
            Ok(())
        }));
    // SAFETY: `core` is a live COM object owned by the webview, used on the main thread that
    // `with_webview` and the completion handlers run on.
    let called = unsafe {
        core.CallDevToolsProtocolMethod(&HSTRING::from(METHOD), &HSTRING::from(*params), &handler)
    };
    if let Err(error) = called {
        finish(&done, Err(format!("{METHOD}: {error}")));
    }
}

/// WebView2 has no paste call; CDP's `commands` runs the editing command a key binding runs.
/// `done` resolves when the `keyUp` completes.
#[cfg(windows)]
fn paste(webview: tauri::webview::PlatformWebview, done: PasteDone) {
    let done = SharedDone::new(std::cell::Cell::new(Some(done)));
    // SAFETY: the controller is a live COM object owned by the webview, used on the main thread
    // that `with_webview` runs on.
    match unsafe { webview.controller().CoreWebView2() } {
        Ok(core) => send_keys(core, &PASTE_KEYS, done),
        Err(error) => finish(&done, Err(error.to_string())),
    }
}

/// The WebKitGTK the app runs on, as `2.52.6`; `None` on macOS and Windows.
#[tauri::command]
pub fn e2e_webkitgtk_version() -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: argument-less getters of the linked library's version.
        let (major, minor, micro) = unsafe {
            (
                webkit2gtk::ffi::webkit_get_major_version(),
                webkit2gtk::ffi::webkit_get_minor_version(),
                webkit2gtk::ffi::webkit_get_micro_version(),
            )
        };
        Ok(Some(format!("{major}.{minor}.{micro}")))
    }
    #[cfg(not(target_os = "linux"))]
    Ok(None)
}
