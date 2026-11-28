//! The Electron renderer's localStorage. The import writes it to `electron-localstorage.json`
//! (`{version, origin, pending, entries}`, `electron_import::app_state`). While the file is
//! pending, the main window's init script sets every key the page does not have yet
//! (`windows/scripts/local-storage-import.js`), then calls `migration_localstorage_applied`,
//! which rewrites the file with `pending: false`. The import never rearms a file that is not
//! pending, so the keys land at most once and never over state the renderer wrote.

use std::path::Path;

use memry_desktop::electron_import::app_state::LOCAL_STORAGE_FILE;
use memry_desktop::vault::fs_atomic::atomic_write;
use serde_json::{Map, Value};

const SCRIPT: &str = include_str!("../windows/scripts/local-storage-import.js");
const ENTRIES: &str = "__MEMRY_ENTRIES__";

/// The init script that applies the pending file under `data_dir`; none when the file is
/// absent, applied or unreadable.
pub fn pending_script(data_dir: &Path) -> Option<String> {
    let file = read(&data_dir.join(LOCAL_STORAGE_FILE))?;
    if file.get("pending") != Some(&Value::Bool(true)) {
        return None;
    }
    // localStorage holds strings only; the import writes nothing else.
    let entries: Map<String, Value> = file
        .get("entries")?
        .as_object()?
        .iter()
        .filter(|(_, value)| value.is_string())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let json = serde_json::to_string(&entries)
        .ok()?
        .replace('<', "\\u003c");
    Some(SCRIPT.replace(ENTRIES, &json))
}

/// Marks the pending file applied, keeping every other field. True when it changed the file; a
/// file that is absent, applied or unreadable stays as it is.
pub fn mark_applied(data_dir: &Path) -> std::io::Result<bool> {
    let path = data_dir.join(LOCAL_STORAGE_FILE);
    let Some(mut file) = read(&path) else {
        return Ok(false);
    };
    if file.get("pending") != Some(&Value::Bool(true)) {
        return Ok(false);
    }
    file.insert("pending".to_owned(), Value::Bool(false));
    atomic_write(&path, format!("{:#}", Value::Object(file)).as_bytes())
        .map_err(std::io::Error::other)?;
    Ok(true)
}

fn read(path: &Path) -> Option<Map<String, Value>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(
                scope = "Migration",
                "{LOCAL_STORAGE_FILE} not read: {error}"
            );
            return None;
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(file)) => Some(file),
        Ok(_) | Err(_) => {
            tracing::warn!(
                scope = "Migration",
                "{LOCAL_STORAGE_FILE} is not a JSON object"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn write(dir: &Path, body: &Value) {
        std::fs::write(dir.join(LOCAL_STORAGE_FILE), body.to_string()).unwrap();
    }

    fn pending(entries: Value) -> Value {
        json!({"version": 1, "origin": "file://", "pending": true, "entries": entries, "later": 7})
    }

    #[test]
    fn a_pending_file_becomes_a_script_with_its_string_entries_and_no_closing_tag() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &pending(json!({"memry:theme": "dark", "x": "</script><b>", "n": 3})),
        );
        let script = pending_script(dir.path()).unwrap();
        assert!(script.contains(r#""memry:theme":"dark""#));
        assert!(script.contains(r#""x":"\u003c/script>\u003cb>""#));
        assert!(
            !script.contains(r#""n":3"#),
            "a non-string value is not set"
        );
        assert!(!script.contains(ENTRIES));
    }

    #[test]
    fn no_script_for_an_absent_applied_or_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(pending_script(dir.path()), None);
        write(
            dir.path(),
            &json!({"version": 1, "pending": false, "entries": {"a": "b"}}),
        );
        assert_eq!(pending_script(dir.path()), None);
        std::fs::write(dir.path().join(LOCAL_STORAGE_FILE), "{torn").unwrap();
        assert_eq!(pending_script(dir.path()), None);
    }

    #[test]
    fn marking_applied_keeps_every_other_field_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &pending(json!({"a": "b"})));
        assert!(mark_applied(dir.path()).unwrap());
        let file: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(LOCAL_STORAGE_FILE)).unwrap())
                .unwrap();
        assert_eq!(file["pending"], json!(false));
        assert_eq!(file["entries"], json!({"a": "b"}));
        assert_eq!(file["later"], json!(7), "an unknown field survives");
        assert!(
            !mark_applied(dir.path()).unwrap(),
            "a second call changes nothing"
        );
        assert_eq!(pending_script(dir.path()), None);
    }

    #[test]
    fn marking_applied_leaves_an_absent_or_unreadable_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!mark_applied(dir.path()).unwrap());
        assert!(!dir.path().join(LOCAL_STORAGE_FILE).exists());
        std::fs::write(dir.path().join(LOCAL_STORAGE_FILE), "{torn").unwrap();
        assert!(!mark_applied(dir.path()).unwrap());
        assert_eq!(
            std::fs::read(dir.path().join(LOCAL_STORAGE_FILE)).unwrap(),
            b"{torn"
        );
    }
}
