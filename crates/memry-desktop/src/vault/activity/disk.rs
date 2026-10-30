//! The two files of the activity log in `<vault>/.memry/`: `activity.jsonl` and
//! `activity-settings.json`. Shared with Electron builds, which read and write both.
//!
//! Both are anyone's input, so each read is bounded by construction: a file is opened only when
//! it is a regular file inside the vault (`file_open`, so a FIFO or a link to a device neither
//! blocks nor streams), read up to its size cap, and the log a line at a time into at most
//! [`MAX_ENTRIES`] kept lines, each dropped by the retention window as soon as it is read.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use super::MAX_ENTRIES;
use super::entry::Line;
use super::parse::{Read, read_line};
use crate::shell::file_open::{LinkPolicy, OpenError, open_under_root_with};
use crate::vault::fs_atomic::{RETRY_DELAYS_MS, atomic_replace_checked};
use crate::vault::layout::MEMRY_DIR;

pub const LOG_FILE: &str = "activity.jsonl";
pub const SETTINGS_FILE: &str = "activity-settings.json";
/// A log at its cap holds 5500 entries of a few hundred bytes each; one whose summaries all
/// carry 50 long paths stays under 64 MiB. A larger file is not read, and never rewritten.
pub const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
/// Every build writes one key; a newer build's keys fit many times over.
pub const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

pub const RETENTION_DAYS: [u32; 3] = [7, 30, 90];
pub const DEFAULT_RETENTION_DAYS: u32 = 30;
const DAY_MS: i64 = 86_400_000;

pub fn log_path(root: &Path) -> PathBuf {
    root.join(MEMRY_DIR).join(LOG_FILE)
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join(MEMRY_DIR).join(SETTINGS_FILE)
}

/// The earliest time the window keeps, or `None` for a retention this build does not know.
pub fn cutoff(retention_days: Option<u32>, now_ms: i64) -> Option<i64> {
    retention_days.map(|days| now_ms - i64::from(days) * DAY_MS)
}

/// `file` of `.memry`, opened when it is a regular file inside the vault; `None` when there is
/// none, at most `cap` bytes read through the returned reader.
fn open_capped(root: &Path, file: &str, cap: u64) -> io::Result<Option<io::Take<fs::File>>> {
    match open_under_root_with(root, &format!("{MEMRY_DIR}/{file}"), LinkPolicy::Allow) {
        Ok(opened) => Ok(opened.map(|opened| opened.take(cap + 1))),
        Err(OpenError::Io(error)) => Err(error),
        Err(error) => Err(io::Error::other(error.to_string())),
    }
}

fn too_large(cap: u64) -> io::Error {
    io::Error::other(format!("larger than {cap} bytes"))
}

/// What the open read of the log found.
pub struct Loaded {
    /// Oldest first: the newest [`MAX_ENTRIES`] lines inside the retention window.
    pub lines: VecDeque<Line>,
    /// Lines that were not JSON objects.
    pub dropped: usize,
    /// Lines the window or the cap dropped.
    pub pruned: usize,
    /// The file ends without a newline: the next append would join its last line.
    pub torn_tail: bool,
    /// `false` when the file exists and could not be read: it is never rewritten.
    pub readable: bool,
}

impl Loaded {
    fn empty(readable: bool) -> Self {
        Self {
            lines: VecDeque::new(),
            dropped: 0,
            pruned: 0,
            torn_tail: false,
            readable,
        }
    }
}

/// The log, keeping the lines at or after `cutoff`. A line whose time this build cannot read is
/// kept by the window.
pub fn read_log(root: &Path, cutoff: Option<i64>) -> Loaded {
    match read_lines(root, cutoff) {
        Ok(loaded) => loaded,
        Err(error) => {
            tracing::warn!(
                scope = "vault_activity",
                "the activity log cannot be read; it is appended to and never rewritten: {error}"
            );
            Loaded::empty(false)
        }
    }
}

fn read_lines(root: &Path, cutoff: Option<i64>) -> io::Result<Loaded> {
    let mut loaded = Loaded::empty(true);
    let Some(file) = open_capped(root, LOG_FILE, MAX_LOG_BYTES)? else {
        return Ok(loaded);
    };
    let mut reader = BufReader::new(file);
    let (mut total, mut raw) = (0u64, Vec::new());
    loop {
        raw.clear();
        let read = reader.read_until(b'\n', &mut raw)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_LOG_BYTES {
            return Err(too_large(MAX_LOG_BYTES));
        }
        let ended = raw.last() == Some(&b'\n');
        loaded.torn_tail = !ended;
        if ended {
            raw.pop();
        }
        // `readFileSync(path, 'utf-8')` decodes bad bytes as U+FFFD the same way.
        let parsed = match read_line(&String::from_utf8_lossy(&raw)) {
            Read::Line(parsed) => parsed,
            Read::Blank => continue,
            Read::Garbage => {
                loaded.dropped += 1;
                continue;
            }
        };
        if cutoff.is_some_and(|cutoff| parsed.at_ms.is_some_and(|at| at < cutoff)) {
            loaded.pruned += 1;
            continue;
        }
        // The kept line takes the buffer instead of a copy of it.
        let text = String::from_utf8(std::mem::take(&mut raw))
            .unwrap_or_else(|bad| String::from_utf8_lossy(bad.as_bytes()).into_owned());
        loaded.lines.push_back(parsed.into_line(text));
        if loaded.lines.len() > MAX_ENTRIES {
            loaded.lines.pop_front();
            loaded.pruned += 1;
        }
    }
    Ok(loaded)
}

/// The settings file as a JSON object; `None` when there is none.
fn read_settings(root: &Path) -> Result<Option<Map<String, Value>>, String> {
    let Some(mut file) =
        open_capped(root, SETTINGS_FILE, MAX_SETTINGS_BYTES).map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(too_large(MAX_SETTINGS_BYTES).to_string());
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(settings)) => Ok(Some(settings)),
        Ok(_) => Err("not a JSON object".into()),
        Err(error) => Err(error.to_string()),
    }
}

/// The retention the settings file names: the default when there is no file, and `None` when
/// it names one this build does not know (a newer build's), which drops no entry by its age.
pub fn read_retention(root: &Path) -> Option<u32> {
    let settings = match read_settings(root) {
        Ok(None) => return Some(DEFAULT_RETENTION_DAYS),
        Ok(Some(settings)) => settings,
        Err(_) => return None,
    };
    let days = settings.get("retentionDays")?.as_f64()?;
    RETENTION_DAYS.into_iter().find(|d| f64::from(*d) == days)
}

#[derive(Debug, thiserror::Error)]
pub enum DiskError {
    /// The file exists and is not what any build writes; replacing it could lose what it holds.
    #[error("{file} cannot be read, so it is left as it is: {message}")]
    Unreadable { file: &'static str, message: String },
    #[error("{file} could not be written: {source}")]
    Write {
        file: &'static str,
        #[source]
        source: io::Error,
    },
}

/// Writes `retentionDays` into the settings file. Every other key of the file stays where it
/// is, so a key a newer build adds survives; a file Electron wrote (that key alone) gets the
/// bytes Electron writes, `JSON.stringify({ retentionDays }, null, 2)` and a newline. A file
/// that is there and is not a JSON object is refused.
pub fn write_retention(root: &Path, days: u32) -> Result<(), DiskError> {
    let unreadable = |message: String| DiskError::Unreadable {
        file: SETTINGS_FILE,
        message,
    };
    let mut settings = read_settings(root).map_err(unreadable)?.unwrap_or_default();
    settings.insert("retentionDays".into(), days.into());
    let mut text = serde_json::to_string_pretty(&Value::Object(settings))
        .map_err(|error| unreadable(error.to_string()))?;
    text.push('\n');
    replace(root, SETTINGS_FILE, text.as_bytes())
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

fn replace(root: &Path, file: &'static str, bytes: &[u8]) -> Result<(), DiskError> {
    let write = |source| DiskError::Write { file, source };
    ensure_memry_dir(root).map_err(write)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_replace_checked(
        &root.join(MEMRY_DIR).join(file),
        bytes,
        &delays,
        &mut || Ok(()),
    )
    .map_err(|error| write(error.source))
}

/// Appends to the log, creating it owner-only when it is not there (`appendFile`, mode 0600).
/// Only to a regular file: a link is not followed out of the vault, and a FIFO does not block.
fn append(root: &Path, bytes: &[u8]) -> io::Result<()> {
    ensure_memry_dir(root)?;
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(log_path(root))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    file.write_all(bytes)
}

/// Creates the log file when it is not there, so it can be revealed.
pub fn touch(root: &Path) -> io::Result<()> {
    append(root, b"")
}

/// One write of the log: new lines at its end, or the whole file again.
pub enum Work {
    /// `separate` starts the lines on a line of their own, after a last line with no newline.
    Append { lines: Vec<String>, separate: bool },
    /// `unwritten` are the new lines among `lines`, appended instead if the rewrite fails.
    Rewrite {
        lines: Vec<String>,
        unwritten: Vec<String>,
    },
}

impl Work {
    pub fn run(&self, root: &Path) -> Result<(), DiskError> {
        match self {
            Self::Append { lines, separate } => {
                let mut text = if *separate {
                    "\n".to_owned()
                } else {
                    String::new()
                };
                text.push_str(&lines.join("\n"));
                text.push('\n');
                append(root, text.as_bytes()).map_err(|source| DiskError::Write {
                    file: LOG_FILE,
                    source,
                })
            }
            Self::Rewrite { lines, .. } => {
                let mut text = lines.join("\n");
                if !text.is_empty() {
                    text.push('\n');
                }
                replace(root, LOG_FILE, text.as_bytes())
            }
        }
    }
}
