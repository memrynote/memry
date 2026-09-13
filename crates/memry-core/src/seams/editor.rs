//! The editor-host seam, chapter 12 and FR-016.
//!
//! The core owns the Y.Doc; the WebView owns markdown. This seam is the relay
//! between them and carries **no logic**: it moves a JSON message to the guest
//! and a JSON message back.
//!
//! **The core never parses or serialises markdown** (chapter 12 §1). Both
//! directions belong to the bundle: document to markdown is `export-markdown`,
//! markdown to document is `seed-from-markdown`, and a new note's `content`
//! payload is handed to the guest **verbatim** so the bundle's own frontmatter
//! splitter runs there. A `pulldown-cmark` in this crate would be a second
//! markdown implementation on the phone path, and two implementations is how
//! byte identity dies.

use crate::api::errors::EditorError;

/// A message crossing the host-to-guest bridge.
///
/// `payload` is the JSON body as bytes. It is opaque to the shell: the shell
/// relays it and does not read it, because a shell that reads it grows an
/// opinion about `BRIDGE_PROTOCOL_VERSION`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct BridgeMessage {
    pub kind: String,
    pub payload: Vec<u8>,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait EditorHost: Send + Sync {
    /// Relays a message to the guest and waits for its reply.
    async fn request(&self, message: BridgeMessage) -> Result<BridgeMessage, EditorError>;

    /// Relays a message with no reply expected.
    fn post(&self, message: BridgeMessage) -> Result<(), EditorError>;

    /// The bundle's protocol version, read once at load. A mismatch with the
    /// core's expected version is a hard failure rather than a degraded mode:
    /// the bundle and the core ship together, so a mismatch means the build
    /// pairing broke.
    fn bridge_protocol_version(&self) -> u32;
}
