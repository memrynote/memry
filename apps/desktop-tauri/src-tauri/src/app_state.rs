//! Global runtime state shared across commands.

use crate::auth::linking::PendingLinkingRegistry;
use crate::auth::AuthRuntime;
use crate::db::Db;
use crate::vault::VaultRuntime;
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
    pub auth: Arc<AuthRuntime>,
    pub linking: Arc<PendingLinkingRegistry>,
}

impl AppState {
    pub fn new(
        db: Db,
        vault: Arc<VaultRuntime>,
        auth: Arc<AuthRuntime>,
        linking: Arc<PendingLinkingRegistry>,
    ) -> Self {
        Self {
            db,
            vault,
            auth,
            linking,
        }
    }
}
