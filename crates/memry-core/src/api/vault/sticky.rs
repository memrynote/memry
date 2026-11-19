//! The desktop sticky drafts' accessor on [`Vault`] (desktop Step 31). Not part of the FFI
//! surface: the Rust desktop shell is its only caller.

use std::sync::Arc;

use crate::api::errors::AuthError;
use crate::api::sticky_store::StickyStore;
use crate::api::tasks::Tasks;
use crate::api::vault::Vault;
use crate::seams::secure_store::SecureStore;

impl Vault {
    /// The sticky drafts, written under this device's identity.
    #[doc(hidden)]
    pub fn sticky_store(&self, store: Arc<dyn SecureStore>) -> Result<StickyStore, AuthError> {
        let tasks = Tasks::over(self.db.clone(), &store)?;
        Ok(StickyStore::over(tasks.db, tasks.device_id))
    }
}
