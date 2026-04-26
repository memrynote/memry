//! Global runtime state shared across commands.

use crate::auth::AuthRuntime;
use crate::db::Db;
use crate::vault::VaultRuntime;
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
    pub auth: Arc<AuthRuntime>,
}

impl AppState {
    pub fn new(db: Db, vault: Arc<VaultRuntime>, auth: Arc<AuthRuntime>) -> Self {
        Self { db, vault, auth }
    }
}
