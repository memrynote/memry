//! The folder scan of `noteplan-importer.ts` (`scanSource`, `collectArea`) and `mapFiles`: the
//! picked NotePlan folder to a plan of notes and journal entries, writing nothing.
//!
//! Electron followed no link and skipped any it met without a word, and it walked any depth.
//! Here every refusal is reported: a link, a folder past [`MAX_FOLDER_DEPTH`], a folder whose
//! name no Windows device can create, an area folder that resolves outside the pick, and a
//! folder that cannot be listed.

use std::fs;
use std::path::{Path, PathBuf};

use super::map::{CalendarFile, classify_calendar_stem};
use crate::import::ImportContext;
use crate::import::messages::ImportText;
use crate::vault::paths::is_reserved_windows_name;

/// Folders NotePlan owns that hold nothing importable.
const IGNORED_DIRS: [&str; 5] = ["Filters", "@Trash", "Plugins", "Caches", ".git"];

/// The deepest folder entered below an area folder.
pub const MAX_FOLDER_DEPTH: usize = 32;

const ROOT_FOLDER: &str = "NotePlan";
const CALENDAR_FOLDER: &str = "NotePlan/Calendar";
const ARCHIVE_FOLDER: &str = "NotePlan/Archive";

pub const LINK_NOT_FOLLOWED: &str = "Symbolic link not followed";
pub const OUTSIDE_PICK: &str = "Folder resolves outside the selected folder";
pub const TOO_DEEP: &str = "Folder nested too deep";
pub const RESERVED_NAME: &str = "Folder name is reserved on Windows";
const NOT_CALENDAR: &str = "Not a NotePlan calendar filename";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Area {
    Calendar,
    Notes,
    Archive,
}

/// A file that becomes a note (`PlannedNote`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedNote {
    pub path: PathBuf,
    /// The folder the person picked: assets stay inside it.
    pub root: PathBuf,
    /// The fallback title; the body's H1 wins.
    pub title: String,
    pub folder: String,
}

/// A day file that becomes a journal entry (`PlannedJournal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedJournal {
    pub path: PathBuf,
    pub root: PathBuf,
    /// `YYYY-MM-DD`.
    pub date: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub notes: Vec<PlannedNote>,
    pub journals: Vec<PlannedJournal>,
}

/// `path.extname`: from the last `.` that does not open the name.
fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot..],
        _ => "",
    }
}

fn is_note_file(name: &str) -> bool {
    matches!(extname(name).to_lowercase().as_str(), ".txt" | ".md")
}

/// A folder name the vault cannot carry to every platform: a Windows device name, or a `\`
/// that Windows reads as a separator.
fn is_reserved_folder(name: &str) -> bool {
    let base = &name[..name.find('.').unwrap_or(name.len())];
    name.contains('\\') || is_reserved_windows_name(base.trim_end_matches(' '))
}

/// `scanSource`: the areas of one picked folder, or the whole folder as notes when it has none.
pub fn scan_source(source: &Path, plan: &mut Plan, ctx: &mut ImportContext) {
    let real_source = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    let mut matched = false;
    for (name, area) in [
        ("Calendar", Area::Calendar),
        ("Notes", Area::Notes),
        ("@Archive", Area::Archive),
    ] {
        let dir = source.join(name);
        if !fs::metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        matched = true;
        // `Notes` may itself be a link (the data folder of a synced install often is one).
        if !fs::canonicalize(&dir).is_ok_and(|real| real.starts_with(&real_source)) {
            ctx.report_skipped(name, Some(ImportText::from(OUTSIDE_PICK)));
            continue;
        }
        collect_area(&dir, source, area, plan, ctx);
    }
    if !matched {
        collect_area(source, source, Area::Notes, plan, ctx);
    }
}

/// `collectArea`, depth first, each folder's entries by name; iterative.
fn collect_area(dir: &Path, root: &Path, area: Area, plan: &mut Plan, ctx: &mut ImportContext) {
    let mut stack = vec![match sorted_entries(dir, "") {
        Ok(entries) => entries.into_iter(),
        Err(error) => {
            ctx.report_failed(&dir.to_string_lossy(), &error.to_string());
            return;
        }
    }];
    while let Some(entries) = stack.last_mut() {
        let Some((rel, path, kind)) = entries.next() else {
            stack.pop();
            continue;
        };
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_owned();
        if kind.is_symlink() {
            ctx.report_skipped(&rel, Some(ImportText::from(LINK_NOT_FOLLOWED)));
        } else if kind.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if is_reserved_folder(&name) {
                ctx.report_skipped(&rel, Some(ImportText::from(RESERVED_NAME)));
            } else if stack.len() > MAX_FOLDER_DEPTH {
                ctx.report_skipped(&rel, Some(ImportText::from(TOO_DEEP)));
            } else {
                match sorted_entries(&path, &rel) {
                    Ok(entries) => stack.push(entries.into_iter()),
                    Err(error) => ctx.report_failed(&path.to_string_lossy(), &error.to_string()),
                }
            }
        } else if kind.is_file() && name != ".DS_Store" && is_note_file(&name) {
            plan_file(&rel, path, root, area, plan, ctx);
        }
    }
}

type Entry = (String, PathBuf, fs::FileType);

/// A folder's entries by name, each with its `/`-separated path under the area folder. Node
/// lists them in the order the file system returns; sorting makes a run repeatable.
fn sorted_entries(dir: &Path, rel_dir: &str) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        entries.push((entry.file_name(), entry.path(), entry.file_type()?));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries
        .into_iter()
        .map(|(name, path, kind)| {
            let name = name.to_string_lossy();
            let rel = if rel_dir.is_empty() {
                name.into_owned()
            } else {
                format!("{rel_dir}/{name}")
            };
            (rel, path, kind)
        })
        .collect())
}

/// `mapFiles` for one file: a day file becomes a journal entry, any other calendar period a
/// note in `NotePlan/Calendar`, a note one in `NotePlan` (or `NotePlan/Archive`) under its
/// folder.
fn plan_file(
    rel: &str,
    path: PathBuf,
    root: &Path,
    area: Area,
    plan: &mut Plan,
    ctx: &mut ImportContext,
) {
    let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    // `path.basename(rel, ext)` with the lower-cased extension: `X.TXT` keeps its suffix.
    let ext = extname(name).to_lowercase();
    let stem = name.strip_suffix(ext.as_str()).unwrap_or(name);
    let root = root.to_path_buf();
    if area == Area::Calendar {
        match classify_calendar_stem(stem) {
            None => ctx.report_skipped(rel, Some(ImportText::from(NOT_CALENDAR))),
            Some(CalendarFile::Day(date)) => {
                plan.journals.push(PlannedJournal { path, root, date })
            }
            Some(CalendarFile::Period(label)) => plan.notes.push(PlannedNote {
                path,
                root,
                title: label,
                folder: CALENDAR_FOLDER.to_owned(),
            }),
        }
        return;
    }
    let base = if area == Area::Archive {
        ARCHIVE_FOLDER
    } else {
        ROOT_FOLDER
    };
    plan.notes.push(PlannedNote {
        path,
        root,
        title: stem.to_owned(),
        folder: if dir.is_empty() {
            base.to_owned()
        } else {
            format!("{base}/{dir}")
        },
    });
}
