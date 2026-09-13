//! The CRDT tier: note and journal **bodies**, chapter 07 and chapter 12 §12.5.
//!
//! Three pieces, and the boundaries between them are the point:
//!
//! - [`registry`] owns the in-memory `yrs::Doc` for every document the process
//!   has open, one `Arc<Doc>` each, and is the only place a transaction is
//!   opened;
//! - [`update_log`] owns the durable two-namespace log in `yjs_updates` and
//!   `yjs_snapshots`, and knows nothing about yrs beyond "these are bytes";
//! - [`lifecycle`] owns the state machine of data-model §C.4 and knows about
//!   neither, so it can be driven and asserted without a document or a database.
//!
//! **The core never parses or serialises markdown** (chapter 12 §12.1.2). Both
//! directions live in the editor bundle. The only text operation this tier will
//! ever own is [`text_extract::extract_text`], a plain-text walk of the
//! `prosemirror` fragment that keeps heading and list markers and claims no
//! markdown fidelity.
//!
//! **The wire carries no item type** (chapter 07 §7.1): a journal body is a
//! document in the same feed as a note, keyed by the journal record's own id,
//! and every route here treats the document id as an opaque string. Nothing in
//! this module branches on whether an id looks like `abc123def456` or
//! `j2026-04-16`.

pub mod errors;
pub mod lifecycle;
pub mod registry;
pub mod text_extract;
pub mod update_log;

pub use errors::CrdtError;
pub use lifecycle::{DocumentLifecycle, DocumentState, LifecycleConfig};
pub use registry::{Document, DocumentRegistry, NOTE_DOC_ROOTS, client_id_from_device_id};
pub use text_extract::{BODY_FRAGMENT, extract_text};
pub use update_log::{Namespace, SnapshotRow, UpdateRow};
