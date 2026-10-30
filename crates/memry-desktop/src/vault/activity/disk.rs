//! The two files of the activity log in `<vault>/.memry/`: `activity.jsonl` and
//! `activity-settings.json`. Shared with Electron builds, which read and write both.

use std::fs::{self, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use super::entry::{Line, Read, read_line};
use crate::vault::fs_atomic::{RETRY_DELAYS_MS, atomic_replace_checked};
use crate::vault::layout::MEMRY_DIR;

pub const LOG_FILE: &str = "activity.jsonl";
pub const SETTINGS_FILE: &str = "activity-settings.json";
/// A log at its cap holds 5500 entries of a few hundred bytes each; one whose summaries all
/// carry 50 long paths stays under 64 MiB. A larger file is not read, and never rewritten.
pub const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

pub const RETENTION_DAYS: [u32; 3] = [7, 30, 90];
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

pub fn log_path(root: &Path) -> PathBuf {
    root.join(MEMRY_DIR).join(LOG_FILE)
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join(MEMRY_DIR).join(SETTINGS_FILE)
}

/// What the open read of the log found.
pub struct Loaded {
    /// Oldest first.
    pub lines: Vec<Line>,
    /// Lines that were not JSON objects.
    pub dropped: usize,
    /// The file ends without a newline: the next append would join its last line.
    pub torn_tail: bool,
    /// `false` when the file exists and could not be read: it is never rewritten.
    pub readable: bool,
}

pub fn read_log(root: &Path) -> Loaded {
    let empty = |readable| Loaded {
        lines: Vec::new(),
        dropped: 0,
        torn_tail: false,
        readable,
    };
    let path = log_path(root);
    let bytes = match read_capped(&path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return empty(true),
        Err(error) => {
            tracing::warn!(
                scope = "vault_activity",
                "the activity log cannot be read; it is appended to and never rewritten: {error}"
            );
            return empty(false);
        }
    };
    // `readFileSync(path, 'utf-8')` decodes bad bytes as U+FFFD the same way.
    let content = String::from_utf8_lossy(&bytes);
    let mut loaded = empty(true);
    loaded.torn_tail = !content.is_empty() && !content.ends_with('\n');
    for raw in content.split('\n') {
        match read_line(raw) {
            Read::Line(line) => loaded.lines.push(*line),
            Read::Blank => {}
            Read::Garbage => loaded.dropped += 1,
        }
    }
    loaded
}

fn read_capped(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LOG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LOG_BYTES {
        return Err(io::Error::other(format!(
            "larger than {MAX_LOG_BYTES} bytes"
        )));
    }
    Ok(Some(bytes))
}

/// The retention the settings file names, or the default when it names none this build knows.
pub fn read_retention(root: &Path) -> u32 {
    fs::read(settings_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok())
        .and_then(|value| value.get("retentionDays")?.as_f64())
        .and_then(|days| RETENTION_DAYS.into_iter().find(|d| f64::from(*d) == days))
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

#[derive(Debug, thiserror::Error)]
pub enum DiskError {
    /// The file exists and is not what any build writes; replacing it could lose what it holds.
    #[error("{} cannot be read, so it is left as it is: {message}", path.display())]
    Unreadable { path: PathBuf, message: String },
    #[error("{} could not be written: {source}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Writes `retentionDays` into the settings file. Every other key of the file stays where it
/// is, so a key a newer build adds survives; a file Electron wrote (that key alone) gets the
/// bytes Electron writes, `JSON.stringify({ retentionDays }, null, 2)` and a newline. A file
/// that is there and is not a JSON object is refused.
pub fn write_retention(root: &Path, days: u32) -> Result<(), DiskError> {
    let path = settings_path(root);
    let unreadable = |message: String| DiskError::Unreadable {
        path: path.clone(),
        message,
    };
    let mut settings = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(settings)) => settings,
            Ok(_) => return Err(unreadable("not a JSON object".into())),
            Err(error) => return Err(unreadable(error.to_string())),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(unreadable(error.to_string())),
    };
    settings.insert("retentionDays".into(), days.into());
    let mut text = serde_json::to_string_pretty(&Value::Object(settings))
        .map_err(|error| unreadable(error.to_string()))?;
    text.push('\n');
    replace(root, &path, text.as_bytes())
}

/// Never `create_dir_all`: a vault that is away (an unplugged drive, a renamed folder) would
/// get its root back as a stray folder that a remount then collides with. Its entries stay in
/// memory until it is back.
fn ensure_memry_dir(root: &Path) -> io::Result<()> {
    match fs::create_dir(root.join(MEMRY_DIR)) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => Ok(()),
    }
}

fn replace(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), DiskError> {
    let write = |source| DiskError::Write {
        path: path.to_owned(),
        source,
    };
    ensure_memry_dir(root).map_err(write)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_replace_checked(path, bytes, &delays, &mut || Ok(()))
        .map_err(|error| write(error.source))
}

/// Appends to the log, creating it owner-only when it is not there (`appendFile`, mode 0600).
fn append(root: &Path, bytes: &[u8]) -> io::Result<()> {
    ensure_memry_dir(root)?;
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(log_path(root))?.write_all(bytes)
}

/// Creates the log file when it is not there, so it can be revealed.
pub fn touch(root: &Path) -> io::Result<()> {
    append(root, b"")
}

/// One write of the log: new lines at its end, or the whole file again.
pub enum Work {
    Append(Vec<String>),
    Rewrite(Vec<String>),
}

impl Work {
    pub fn run(&self, root: &Path) -> Result<(), DiskError> {
        match self {
            Self::Append(lines) => {
                let mut text = lines.join("\n");
                text.push('\n');
                append(root, text.as_bytes()).map_err(|source| DiskError::Write {
                    path: log_path(root),
                    source,
                })
            }
            Self::Rewrite(lines) => {
                let mut text = lines.join("\n");
                if !text.is_empty() {
                    text.push('\n');
                }
                replace(root, &log_path(root), text.as_bytes())
            }
        }
    }
}
