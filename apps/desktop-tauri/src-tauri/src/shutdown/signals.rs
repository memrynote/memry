//! SIGINT and SIGTERM (Ctrl-C on Windows) quit through the same ordered sequence as Cmd+Q.

use tauri::{AppHandle, Wry};

pub fn spawn(app: &AppHandle<Wry>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        wait().await;
        tracing::info!(scope = "Shutdown", "termination signal received");
        app.exit(0);
    });
}

#[cfg(unix)]
async fn wait() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        tracing::warn!(
            scope = "Shutdown",
            "could not listen for termination signals"
        );
        return std::future::pending().await;
    };
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(windows)]
async fn wait() {
    if tokio::signal::ctrl_c().await.is_err() {
        tracing::warn!(scope = "Shutdown", "could not listen for Ctrl-C");
        std::future::pending::<()>().await;
    }
}
