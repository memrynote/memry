use crate::db::migrations;
use rusqlite::Connection;

pub fn open_in_memory_with_migrations() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory database");
    migrations::apply_pending(&mut conn).expect("apply migrations");
    conn
}
