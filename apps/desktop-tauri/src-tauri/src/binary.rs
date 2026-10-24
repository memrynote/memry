//! Raw payloads over IPC. Commands that take a `tauri::ipc::Request` or return a
//! `tauri::ipc::Response` are plain `#[tauri::command]` functions listed in [`COMMANDS`] and
//! [`handler`]. They are not specta commands and do not enter `bindings.ts`; the renderer side
//! is `ipc-binary.ts`.

use serde::de::DeserializeOwned;
use tauri::Runtime;
use tauri::ipc::{Channel, Invoke, InvokeBody, InvokeResponseBody, Request, Response};

use crate::commands::error::{CommandError, ErrorKind};

/// Header that carries the JSON metadata of a raw request, non-ASCII escaped as `\uXXXX`.
pub const META_HEADER: &str = "x-memry-meta";

/// Names of the binary commands, routed to [`handler`] by `registry::invoke_handler`.
pub const COMMANDS: &[&str] = &[];

/// The handler of the binary commands. Domain steps add `tauri::generate_handler!` entries.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![]
}

/// The raw request body.
pub fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], CommandError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(CommandError::new(
            ErrorKind::Invalid,
            "binary_body_missing",
            "Expected a raw request body.",
        )),
    }
}

/// The metadata the renderer sent in [`META_HEADER`].
pub fn meta<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, CommandError> {
    let value = request.headers().get(META_HEADER).ok_or_else(|| {
        CommandError::new(
            ErrorKind::Invalid,
            "binary_meta_missing",
            "The request carries no metadata header.",
        )
    })?;
    let text = value.to_str().map_err(|_| {
        CommandError::new(
            ErrorKind::Invalid,
            "binary_meta_encoding",
            "The metadata header is not ASCII.",
        )
    })?;
    serde_json::from_str(text).map_err(|error| {
        CommandError::new(
            ErrorKind::Invalid,
            "binary_meta_invalid",
            format!("The metadata header is not valid: {error}"),
        )
    })
}

/// A raw response body.
pub fn response(bytes: Vec<u8>) -> Response {
    Response::new(InvokeResponseBody::Raw(bytes))
}

/// Send one raw message down a channel. An error means the receiving webview is gone.
pub fn send_chunk(
    channel: &Channel<InvokeResponseBody>,
    bytes: Vec<u8>,
) -> Result<(), CommandError> {
    channel
        .send(InvokeResponseBody::Raw(bytes))
        .map_err(|error| {
            CommandError::new(
                ErrorKind::Transport,
                "channel_closed",
                format!("Cannot send to the channel: {error}"),
            )
        })
}
