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
        .with_webview(move |webview| {
            done.send(paste(webview)).ok();
        })
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

#[cfg(target_os = "macos")]
fn paste(webview: tauri::webview::PlatformWebview) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // SAFETY: `inner` is the live WKWebView, used on the main thread that `with_webview` runs on;
    // `paste:` is the responder action the Edit menu's Paste sends.
    unsafe {
        let view = &*webview.inner().cast::<AnyObject>();
        let _: () = msg_send![view, paste: None::<&AnyObject>];
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn paste(webview: tauri::webview::PlatformWebview) -> Result<(), String> {
    use webkit2gtk::WebViewExt;

    webview.inner().execute_editing_command("Paste");
    Ok(())
}

/// WebView2 has no paste call; CDP's `commands` runs the editing command a key binding runs.
#[cfg(windows)]
fn paste(webview: tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    const KEYS: [&str; 2] = [
        r#"{"type":"rawKeyDown","modifiers":2,"key":"v","code":"KeyV","windowsVirtualKeyCode":86,"commands":["paste"]}"#,
        r#"{"type":"keyUp","modifiers":2,"key":"v","code":"KeyV","windowsVirtualKeyCode":86}"#,
    ];
    // SAFETY: the controller and its core are live COM objects owned by the webview, used on the
    // main thread that `with_webview` runs on.
    unsafe {
        let core = webview
            .controller()
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        for params in KEYS {
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            core.CallDevToolsProtocolMethod(
                &HSTRING::from("Input.dispatchKeyEvent"),
                &HSTRING::from(params),
                &handler,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
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
