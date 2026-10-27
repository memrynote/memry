//! The loopback media server of a launch: started before the window, so its origin and token
//! are in the window's init script. The server itself, its routes and its checks are
//! `memry_desktop::shell::loopback`.

use std::sync::Arc;

use memry_desktop::shell::loopback::{LoopbackServer, start};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::protocols;

/// Binds the server and keeps it for the life of the app.
pub fn start_server(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let handle = app.clone();
    let roots = Arc::new(move || protocols::roots(&handle));
    let server = tauri::async_runtime::block_on(start(roots, cfg!(windows))).map_err(|error| {
        CommandError::new(ErrorKind::Internal, "loopback_start", error.to_string())
    })?;
    app.manage(server);
    Ok(())
}

/// `(origin, token)` of the running server.
pub fn address(app: &AppHandle<Wry>) -> Option<(String, String)> {
    app.try_state::<LoopbackServer>()
        .map(|server| (server.origin(), server.token().to_owned()))
}
