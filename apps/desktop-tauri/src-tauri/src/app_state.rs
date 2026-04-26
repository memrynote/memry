//! Global runtime state shared across commands.

use crate::db::Db;
use crate::vault::VaultRuntime;
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
}

impl AppState {
    pub fn new(db: Db, vault: Arc<VaultRuntime>) -> Self {
        Self { db, vault }
    }
}
