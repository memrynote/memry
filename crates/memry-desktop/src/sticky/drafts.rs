//! The open vault's sticky drafts (`stickies/drafts.ts`), written under this device's identity.

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::AuthError;
pub use memry_core::api::sticky_store::{StickyDraft, StickyStore};
pub use memry_core::domain::sticky_draft::StickyKind;
use memry_core::seams::secure_store::SecureStore;

use crate::session::OpenVault;

/// The drafts of `open`. Mints this device's identity first when it has none, as the other
/// desktop writers do.
pub fn open(open: &OpenVault, identity: Arc<dyn SecureStore>) -> Result<StickyStore, AuthError> {
    ensure_device_identity(identity.clone())?;
    open.vault.sticky_store(identity)
}
