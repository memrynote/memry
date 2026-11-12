//! The Location filter's option list (desktop's `buildTaskLocationOptions`):
//! the folders and notes that hold tasks, with counts, in tree order.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use super::filters::js_trim;
use super::{FilterTask, TaskNoteInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationKind {
    Folder,
    Note,
}

impl LocationKind {
    /// Desktop's name: `folder` or `note`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Note => "note",
        }
    }
}

/// One row of the Location filter panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationOption {
    pub kind: LocationKind,
    /// Folder path or note id: the value the filter stores.
    pub value: String,
    pub label: String,
    /// Folder a note sits in, or a folder's parent path.
    pub context: String,
    /// Nesting below the vault root; 0 for every row while searching.
    pub depth: u32,
    /// Top-level tasks the row would select.
    pub count: u32,
}

/// Distinct task ids per key, keeping first-insertion order the way a JS `Map`
/// does: equal sort keys keep that order through the stable sort.
#[derive(Default)]
struct Buckets {
    order: Vec<String>,
    tasks: HashMap<String, HashSet<String>>,
}

impl Buckets {
    fn touch(&mut self, key: &str) -> &mut HashSet<String> {
        if !self.tasks.contains_key(key) {
            self.order.push(key.to_owned());
        }
        self.tasks.entry(key.to_owned()).or_default()
    }

    fn count(&self, key: &str) -> u32 {
        self.tasks
            .get(key)
            .map_or(0, |ids| u32::try_from(ids.len()).unwrap_or(u32::MAX))
    }
}

fn ancestors(folder_path: &str) -> Vec<&str> {
    if folder_path.is_empty() {
        return Vec::new();
    }
    folder_path
        .match_indices('/')
        .map(|(index, _)| &folder_path[..index])
        .chain(std::iter::once(folder_path))
        .collect()
}

fn segments(path: &str) -> u32 {
    u32::try_from(path.split('/').count()).unwrap_or(u32::MAX)
}

/// JS `<` on strings: UTF-16 code unit order.
fn js_compare(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Folders and notes that hold at least one top-level task of `tasks`, as a
/// tree in display order: within a folder its notes (by title), then its
/// subfolders. A task counts for its source note and every linked note, and
/// for every folder above them. Selected folders and notes stay listed with
/// what they hold, even nothing. A non-blank `query` keeps the rows whose
/// label contains it, case-folded, all at depth 0.
pub fn location_options(
    tasks: &[&FilterTask],
    note_index: &HashMap<String, TaskNoteInfo>,
    selected_folder_paths: &[String],
    selected_note_ids: &[String],
    query: &str,
) -> Vec<LocationOption> {
    let mut notes = Buckets::default();
    let mut folders = Buckets::default();
    for task in tasks.iter().filter(|task| task.parent_id.is_none()) {
        // An empty source id is falsy in the TypeScript and touches no note.
        let source = task.source_note_id.as_deref().filter(|id| !id.is_empty());
        for note_id in source
            .into_iter()
            .chain(task.linked_note_ids.iter().map(String::as_str))
        {
            let Some(info) = note_index.get(note_id) else {
                continue;
            };
            notes.touch(note_id).insert(task.id.clone());
            for folder in ancestors(&info.folder_path) {
                folders.touch(folder).insert(task.id.clone());
            }
        }
    }
    for path in selected_folder_paths {
        for folder in ancestors(path) {
            folders.touch(folder);
        }
    }

    let mut rows: Vec<(String, LocationOption)> = Vec::new();
    for path in &folders.order {
        rows.push((
            format!("{}/", path.to_lowercase()),
            LocationOption {
                kind: LocationKind::Folder,
                value: path.clone(),
                label: path.rsplit('/').next().unwrap_or(path).to_owned(),
                context: path
                    .rsplit_once('/')
                    .map_or("", |(parent, _)| parent)
                    .to_owned(),
                depth: segments(path) - 1,
                count: folders.count(path),
            },
        ));
    }
    let mut seen = HashSet::new();
    for note_id in notes.order.iter().chain(selected_note_ids) {
        if !seen.insert(note_id.as_str()) {
            continue;
        }
        let Some(info) = note_index.get(note_id) else {
            continue;
        };
        let folder = &info.folder_path;
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{}/", folder.to_lowercase())
        };
        rows.push((
            format!("{prefix}\u{0}{}", info.title.to_lowercase()),
            LocationOption {
                kind: LocationKind::Note,
                value: note_id.clone(),
                label: info.title.clone(),
                context: folder.clone(),
                depth: if folder.is_empty() {
                    0
                } else {
                    segments(folder)
                },
                count: notes.count(note_id),
            },
        ));
    }
    rows.sort_by(|(a, _), (b, _)| js_compare(a, b));

    let needle = js_trim(query).to_lowercase();
    rows.into_iter()
        .map(|(_, row)| row)
        .filter(|row| needle.is_empty() || row.label.to_lowercase().contains(&needle))
        .map(|row| {
            if needle.is_empty() {
                row
            } else {
                LocationOption { depth: 0, ..row }
            }
        })
        .collect()
}
