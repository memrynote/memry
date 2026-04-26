use crate::db::migrations;
use rusqlite::Connection;
use std::sync::Arc;

pub fn open_in_memory_with_migrations() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory database");
    migrations::apply_pending(&mut conn).expect("apply migrations");
    conn
}

pub fn test_vault_runtime() -> Arc<crate::vault::VaultRuntime> {
    let root = std::env::temp_dir().join(format!("memry-test-vault-{}", nanoid::nanoid!(12)));
    let runtime = crate::vault::VaultRuntime::open_for_test(root).expect("open test vault");
    Arc::new(runtime)
}
