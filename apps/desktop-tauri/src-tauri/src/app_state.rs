//! Global runtime state shared across commands.

use crate::db::Db;

pub struct AppState {
    pub db: Db,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}
