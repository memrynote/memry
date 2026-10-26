//! The crash-durable mirror of a queue: format version 2 is a `{"version":2}` header and one
//! JSON item per line, version 1 is one `{"version":1,"items":[...]}` object (read only).
//! A hard crash then loses nothing that was enqueued; an unknown version is discarded.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const COMPACT_AFTER_LINES: usize = 1000;

pub struct Journal {
    path: PathBuf,
    started: bool,
    lines: usize,
    failure_logged: bool,
}

impl Journal {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            started: false,
            lines: 0,
            failure_logged: false,
        }
    }

    fn on_failure(&mut self, error: &std::io::Error) {
        if !self.failure_logged {
            self.failure_logged = true;
            tracing::warn!(
                scope = "TelemetryQueueStore",
                "failed to persist telemetry queue; a crash would lose it: {error}"
            );
        }
    }

    /// Items the previous process left behind; `[]` on any fault.
    pub fn load<T: DeserializeOwned>(&mut self) -> Vec<T> {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        match parse(&raw) {
            Some(items) => items,
            None => {
                tracing::warn!(
                    scope = "TelemetryQueueStore",
                    "discarding unreadable telemetry queue mirror"
                );
                self.clear();
                Vec::new()
            }
        }
    }

    /// Records one new item as an appended line; rewrites the file from `current` when the
    /// journal has not started or has grown past the compaction mark.
    pub fn append<T: Serialize>(&mut self, item: &T, current: &[T]) {
        if !self.started || self.lines >= COMPACT_AFTER_LINES {
            self.save(current);
            return;
        }
        let result = serde_json::to_string(item)
            .map_err(std::io::Error::other)
            .and_then(|line| {
                OpenOptions::new()
                    .append(true)
                    .open(&self.path)?
                    .write_all(format!("{line}\n").as_bytes())
            });
        match result {
            Ok(()) => {
                self.lines += 1;
                self.failure_logged = false;
            }
            Err(error) => self.on_failure(&error),
        }
    }

    pub fn save<T: Serialize>(&mut self, items: &[T]) {
        let mut text = String::from("{\"version\":2}\n");
        for item in items {
            match serde_json::to_string(item) {
                Ok(line) => {
                    text.push_str(&line);
                    text.push('\n');
                }
                Err(error) => tracing::warn!(
                    scope = "TelemetryQueueStore",
                    "unserializable queue item: {error}"
                ),
            }
        }
        match fs::write(&self.path, text) {
            Ok(()) => {
                self.started = true;
                self.lines = items.len();
                self.failure_logged = false;
            }
            Err(error) => self.on_failure(&error),
        }
    }

    pub fn clear(&mut self) {
        self.started = false;
        self.lines = 0;
        let _ = fs::remove_file(&self.path);
    }
}

fn parse<T: DeserializeOwned>(raw: &str) -> Option<Vec<T>> {
    let (header_line, rest) = raw.split_once('\n').unwrap_or((raw, ""));
    let header: Value = serde_json::from_str(header_line).ok()?;
    let header = header.as_object()?;
    match header.get("version").and_then(Value::as_u64)? {
        1 => header
            .get("items")?
            .as_array()?
            .iter()
            .map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        2 => Some(
            rest.lines()
                .filter(|line| !line.is_empty())
                // A torn last line (the crash) is skipped, not fatal.
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect(),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(dir: &tempfile::TempDir) -> Journal {
        Journal::new(dir.path().join("queue.json"))
    }

    #[test]
    fn appended_items_come_back_and_a_torn_last_line_is_skipped() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut journal = journal(&dir);
        let items = vec![1, 2];
        journal.append(&1, &items[..1]);
        journal.append(&2, &items);
        fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("queue.json"))
            .expect("open")
            .write_all(b"{\"torn")
            .expect("tear");
        assert_eq!(journal.load::<i32>(), vec![1, 2]);
    }

    #[test]
    fn version_one_is_read_and_an_unknown_version_is_discarded() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("queue.json");
        fs::write(&path, r#"{"version":1,"items":[7,8]}"#).expect("v1");
        assert_eq!(journal(&dir).load::<i32>(), vec![7, 8]);
        fs::write(&path, "{\"version\":3}\n1\n").expect("v3");
        assert!(journal(&dir).load::<i32>().is_empty());
        assert!(!path.exists(), "an unreadable mirror is removed");
        fs::write(&path, "garbage").expect("garbage");
        assert!(journal(&dir).load::<i32>().is_empty());
    }

    #[test]
    fn the_journal_compacts_after_a_thousand_lines() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut journal = journal(&dir);
        let mut current = Vec::new();
        for n in 0..1005 {
            current.push(n);
            journal.append(&n, &current);
        }
        let text = fs::read_to_string(dir.path().join("queue.json")).expect("read");
        assert!(text.lines().count() <= 1006);
        assert_eq!(journal.load::<i32>().len(), 1005);
        journal.clear();
        assert!(journal.load::<i32>().is_empty());
    }
}
