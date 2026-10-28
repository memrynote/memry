use crate::commands::error::{CommandError, ErrorKind};

/// Crashes the process the way a native fault does: the crash handler asks the monitor for a
/// minidump, then the process ends. The reply never returns.
#[tauri::command]
pub fn e2e_trigger_crash() -> Result<(), CommandError> {
    if crate::guards::crash_dump::simulate_crash() {
        return Ok(());
    }
    Err(CommandError::new(
        ErrorKind::Invalid,
        "e2e_crash",
        "the crash handler is not attached",
    ))
}

/// Ends the web content process of the calling page a moment after the reply, the way a renderer
/// crash does: WebView2 crashes its renderer (`Page.crash`), WKWebView's process is killed, and
/// WebKitGTK terminates its web process. The process-death hooks then see a real death.
#[tauri::command]
pub fn e2e_kill_page(webview: tauri::Webview<tauri::Wry>) -> Result<(), CommandError> {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Err(error) = webview.with_webview(kill) {
            tracing::warn!(scope = "E2e", "page not killed: {error}");
        }
    });
    Ok(())
}

#[cfg(windows)]
fn kill(webview: tauri::webview::PlatformWebview) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    // SAFETY: the controller and its core are live COM objects owned by the webview, used on the
    // main thread that `with_webview` runs on.
    let called = unsafe {
        webview.controller().CoreWebView2().and_then(|core| {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from("Page.crash"),
                &HSTRING::from("{}"),
                &handler,
            )
        })
    };
    if let Err(error) = called {
        tracing::warn!(scope = "E2e", "Page.crash not sent: {error}");
    }
}

#[cfg(target_os = "macos")]
fn kill(webview: tauri::webview::PlatformWebview) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // SAFETY: `inner` is the live WKWebView, used on the main thread; `_webProcessIdentifier` is
    // WebKit's own test hook and returns a pid_t.
    let pid: i32 = unsafe {
        let view = &*webview.inner().cast::<AnyObject>();
        msg_send![view, _webProcessIdentifier]
    };
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
    if !killed.is_ok_and(|status| status.success()) {
        tracing::warn!(scope = "E2e", "web content process {pid} not killed");
    }
}

#[cfg(target_os = "linux")]
fn kill(webview: tauri::webview::PlatformWebview) {
    use webkit2gtk::WebViewExt;

    webview.inner().terminate_web_process();
}
