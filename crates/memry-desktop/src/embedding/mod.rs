//! Local text embeddings: the model's owner ([`service`]), its load backoff ([`breaker`]) and
//! the pinned model download ([`download`]). Step 23 (#3540).

mod breaker;
pub mod download;
pub mod service;

pub use breaker::{MAX_CONSECUTIVE_FAILURES, RETRY_BASE};

/// The projectors a catch-up pass runs when AI turns on (`reconcileProjections` in
/// ai-settings.ts:105-113). Step 23's queue registers them under these names.
pub const PROJECTORS: [&str; 3] = ["embedding", "image-embedding", "voice-embedding"];
