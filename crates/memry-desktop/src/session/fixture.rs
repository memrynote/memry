use sha2::{Digest, Sha256};

pub(super) use super::*;
use crate::registry::AppConfig;
pub(super) use std::time::Duration;

pub(super) struct Fixture {
    pub(super) dir: tempfile::TempDir,
    pub(super) session: Session,
}

pub(super) fn fixture() -> Fixture {
    fixture_with(HOOK_DEADLINE)
}

pub(super) fn fixture_with(deadline: Duration) -> Fixture {
    let dir = tempfile::tempdir().expect("dir");
    let config = AppConfig::load(dir.path().join("app").join("memry-config.json"));
    std::fs::create_dir_all(dir.path().join("app")).expect("app dir");
    let session = Session::with_hook_deadline(VaultRegistry::new(Arc::new(config)), deadline);
    Fixture { dir, session }
}

impl Fixture {
    pub(super) fn vault(&self, name: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        std::fs::create_dir_all(&path).expect("vault dir");
        path
    }
}

pub(super) fn drain(rx: &Receiver<SessionEvent>) -> Vec<SessionEvent> {
    rx.try_iter().collect()
}

pub(super) fn statuses(events: &[SessionEvent]) -> Vec<SessionStatus> {
    events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::StatusChanged(status) => Some(status.clone()),
            _ => None,
        })
        .collect()
}

pub(super) fn sha(path: &Path) -> String {
    hex::encode(Sha256::digest(std::fs::read(path).expect("read")))
}

pub(super) fn data_db(vault: &Path) -> PathBuf {
    vault.join(".memry/core/data.db")
}

pub(super) fn put_meta(opened: &VaultOpened, key: &'static str, value: &'static str) {
    opened
        .vault
        .vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                [key, value],
            )
            .map(drop)
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect("write meta");
}

pub(super) fn meta(vault: &Path, key: &'static str) -> Option<String> {
    let conn = rusqlite::Connection::open(data_db(vault)).expect("open");
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .ok()
}
