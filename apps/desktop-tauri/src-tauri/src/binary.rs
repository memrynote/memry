//! Raw payloads over IPC. Commands that take a `tauri::ipc::Request` or return a
//! `tauri::ipc::Response` are plain `#[tauri::command]` functions listed in [`COMMANDS`] and
//! [`handler`]. They are not specta commands and do not enter `bindings.ts`; the renderer side
//! is `ipc-binary.ts`.

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::Runtime;
use tauri::ipc::{Channel, Invoke, InvokeBody, InvokeResponseBody, Request, Response};

use crate::commands::error::{CommandError, ErrorKind};

/// Header that carries the JSON metadata of a raw request, non-ASCII escaped as `\uXXXX`.
pub const META_HEADER: &str = "x-memry-meta";

/// Names of the binary commands, routed to [`handler`] by `registry::invoke_handler`.
pub const COMMANDS: &[&str] = &[
    "ai_provider_request",
    "clipboard_write_image",
    "crdt_apply_update",
    "crdt_open_doc",
    "crdt_sync_step_1",
    "crdt_sync_step_2",
    "custom_icons_add",
    "drop_stage_chunk",
    "notes_upload_attachment",
    "notes_upload_attachment_chunk",
];

/// The handler of the binary commands. Domain steps add `tauri::generate_handler!` entries.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::commands::ai::ai_provider_request,
        crate::commands::clipboard::clipboard_write_image,
        crate::commands::editor::crdt_apply_update,
        crate::commands::editor::crdt_open_doc,
        crate::commands::editor::crdt_sync_step_1,
        crate::commands::editor::crdt_sync_step_2,
        crate::commands::custom_icons::custom_icons_add,
        crate::commands::drop_stage::drop_stage_chunk,
        crate::commands::attachments::notes_upload_attachment,
        crate::commands::attachments::notes_upload_attachment_chunk
    ]
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

/// A raw response of a JSON header and bytes: the header's length as 4 bytes big-endian, the
/// header, then `parts` back to back. The header says where each part ends.
pub fn framed(header: &impl Serialize, parts: &[&[u8]]) -> Result<Response, CommandError> {
    let failed = |what: String| CommandError::new(ErrorKind::Internal, "frame_header", what);
    let header = serde_json::to_vec(header).map_err(|error| failed(error.to_string()))?;
    let length = u32::try_from(header.len()).map_err(|error| failed(error.to_string()))?;
    Ok(response(frame(length, &header, parts)))
}

fn frame(length: u32, header: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let total = 4 + header.len() + parts.iter().map(|part| part.len()).sum::<usize>();
    let mut bytes = Vec::with_capacity(total);
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(header);
    for part in parts {
        bytes.extend_from_slice(part);
    }
    bytes
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

#[cfg(test)]
mod tests {
    use super::frame;

    #[test]
    fn a_frame_is_the_big_endian_header_length_the_header_and_the_parts() {
        let header = br#"{"diffLength":2}"#;
        let bytes = frame(16, header, &[&[7, 8], &[9]]);
        assert_eq!(bytes[..4], 16u32.to_be_bytes());
        assert_eq!(&bytes[4..20], header);
        assert_eq!(bytes[20..], [7, 8, 9]);
    }
}
