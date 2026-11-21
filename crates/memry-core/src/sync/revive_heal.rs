use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::Db;

use super::body_pull::BodyPull;

pub fn candidates(_conn: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    Ok(Vec::new())
}

pub async fn run(_db: &Db, _body_pull: &BodyPull) -> Result<usize, StorageError> {
    Ok(0)
}
