//! The readable export of a vault removed from the account (#5612, chapter 12
//! §12.1.4).
//!
//! Every live note and journal day becomes a markdown file with a
//! frontmatter block, in desktop's vault layout, so the folder opens as a
//! desktop vault; the attachments this device holds go beside them. Bodies
//! are rebuilt from the local update log, which holds every edit made on this
//! device whether it was pushed or not.
//!
//! **One way only.** Nothing reads an export back: its markdown and YAML never
//! reach a document, a payload or a vault this app opens. That is why the
//! core writes them here and nowhere else (§12.1, §12.4.3).

mod body;
mod inline;
mod paths;
mod yaml;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crdt::blocks::{extract_blocks, extract_table};
use crate::crdt::errors::CrdtError;
use crate::domain::{attachments, journal_ops, note_meta, reads};
use yaml::Field;

/// One thing the export writes a file for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Note {
        id: String,
        title: String,
        folder: Option<String>,
        file_type: String,
        attachment_id: Option<String>,
    },
    Day {
        id: String,
        date: String,
    },
}

/// What the export left out, so the screen can say so.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Gaps {
    /// Attachments whose bytes are not on this device: never downloaded,
    /// evicted, or named so that they cannot be written safely.
    pub missing_attachments: u32,
    /// Notes and days whose body this build cannot decode.
    pub unreadable: u32,
}

/// Every live note, then every live journal day.
pub fn items(conn: &Connection) -> Result<Vec<Item>, StorageError> {
    let failed = |error: rusqlite::Error| StorageError::Failed {
        what: format!("the export could not list the vault: {error}"),
    };
    let mut items: Vec<Item> = conn
        .prepare(
            "SELECT id, title, folder_path, file_type, attachment_id FROM notes \
             WHERE deleted_at IS NULL ORDER BY COALESCE(folder_path, ''), title, id",
        )
        .map_err(failed)?
        .query_map([], |row| {
            Ok(Item::Note {
                id: row.get(0)?,
                title: row.get(1)?,
                folder: row.get(2)?,
                file_type: row.get(3)?,
                attachment_id: row.get(4)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let days = conn
        .prepare("SELECT id, date FROM journal_entries WHERE deleted_at IS NULL ORDER BY date")
        .map_err(failed)?
        .query_map([], |row| {
            Ok(Item::Day {
                id: row.get(0)?,
                date: row.get(1)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    items.extend(days);
    Ok(items)
}

/// The folder an export writes into, and the names it has handed out.
pub struct Target {
    root: PathBuf,
    images: PathBuf,
    names: paths::Names,
}

impl Target {
    /// `root` is an empty folder the shell made; `images` is the vault's
    /// attachment cache, which `local_path` is relative to.
    pub fn new(root: PathBuf, images: PathBuf) -> Self {
        Self {
            root,
            images,
            names: paths::Names::default(),
        }
    }

    /// Writes one item's file and its attachments.
    pub fn write(
        &mut self,
        conn: &Connection,
        item: &Item,
        gaps: &mut Gaps,
    ) -> Result<(), StorageError> {
        match item {
            Item::Note {
                id,
                title,
                folder,
                file_type,
                attachment_id,
            } if file_type != "markdown" => {
                let folder = paths::folder(folder.as_deref());
                self.binary_note(conn, id, title, &folder, attachment_id.as_deref(), gaps)
            }
            Item::Note {
                id, title, folder, ..
            } => {
                let Some(meta) = note_meta::metadata(conn, id)? else {
                    return Ok(());
                };
                let Some(body) = body(conn, id, gaps)? else {
                    return Ok(());
                };
                let mut fields: Vec<Field> = Vec::new();
                fields.extend(yaml::list("tags", &meta.tags));
                fields.extend(yaml::list("aliases", &meta.aliases));
                fields.extend(yaml::properties(&meta.properties));
                fields.extend(cover(meta.cover_json.as_deref()));
                let folder = paths::folder(folder.as_deref());
                let stem = paths::file_stem(title);
                self.markdown(&folder, &stem, &file(&fields, &body))?;
                self.attachments(conn, id, gaps)
            }
            Item::Day { id, date } => {
                let day = match journal_ops::reads::day(conn, date) {
                    Ok(Some(day)) => day,
                    Ok(None) => return Ok(()),
                    Err(CrdtError::Storage { source }) => return Err(source),
                    Err(_) => {
                        gaps.unreadable += 1;
                        return Ok(());
                    }
                };
                let Some(body) = body(conn, id, gaps)? else {
                    return Ok(());
                };
                let mut fields = vec![Field::new("date", Value::from(day.date.clone()))];
                fields.extend(yaml::list("tags", &day.tags));
                fields.extend(yaml::list("aliases", &day.aliases));
                fields.extend(yaml::properties(&day.properties));
                let stem = paths::file_stem(&day.date);
                self.markdown(&["journal".to_owned()], &stem, &file(&fields, &body))?;
                self.attachments(conn, id, gaps)
            }
        }
    }

    fn markdown(&mut self, folder: &[String], stem: &str, content: &str) -> Result<(), StorageError> {
        loop {
            let segments = self.names.claim(folder, stem, ".md");
            match write_new(&paths::under(&self.root, &segments), content.as_bytes()) {
                // A name the file system folds onto one already written
                // (Unicode normalisation): take the next number.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                result => return result.map_err(write_failed),
            }
        }
    }

    /// A PDF or image note: its own file, at its path, when it is here.
    fn binary_note(
        &mut self,
        conn: &Connection,
        id: &str,
        title: &str,
        folder: &[String],
        attachment_id: Option<&str>,
        gaps: &mut Gaps,
    ) -> Result<(), StorageError> {
        let attachment = match attachment_id {
            Some(attachment_id) => attachments::get(conn, attachment_id)?,
            None => None,
        };
        let source = attachment.as_ref().and_then(|row| self.cached(row.local_path.as_deref()));
        let Some(source) = source else {
            gaps.missing_attachments += 1;
            return Ok(());
        };
        let extension = attachment
            .as_ref()
            .and_then(|row| row.filename.as_deref())
            .and_then(|name| Path::new(paths::basename(name)).extension())
            .and_then(|extension| extension.to_str())
            .filter(|extension| paths::component(extension).is_some())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default();
        let stem = paths::file_stem(title);
        loop {
            let segments = self.names.claim(folder, &stem, &extension);
            match copy_new(&source, &paths::under(&self.root, &segments)) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    gaps.missing_attachments += 1;
                    let _ = id;
                    return Ok(());
                }
                result => return result.map_err(write_failed),
            }
        }
    }

    /// The note's attachments at `attachments/<noteId>/<file name>`, the path
    /// its blocks already point at (`attachments::resolve_for_block`).
    fn attachments(&mut self, conn: &Connection, id: &str, gaps: &mut Gaps) -> Result<(), StorageError> {
        for row in attachments::for_note(conn, id)? {
            let name = row.filename.as_deref().map(paths::basename).and_then(paths::component);
            let (Some(owner), Some(name), Some(source)) =
                (paths::component(id), name, self.cached(row.local_path.as_deref()))
            else {
                gaps.missing_attachments += 1;
                continue;
            };
            let segments = ["attachments".to_owned(), owner.to_owned(), name.to_owned()];
            match copy_new(&source, &paths::under(&self.root, &segments)) {
                // Two attachments with one file name land on one path on
                // desktop as well; the first one stays.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    gaps.missing_attachments += 1;
                }
                result => result.map_err(write_failed)?,
            }
        }
        Ok(())
    }

    /// The cached file for a row, when its path stays inside the cache.
    fn cached(&self, local_path: Option<&str>) -> Option<PathBuf> {
        let relative = Path::new(local_path?);
        let inside = relative.components().next().is_some()
            && relative.components().all(|part| matches!(part, Component::Normal(_)));
        inside.then(|| self.images.join(relative))
    }
}

/// The body as markdown, or `None` (counted) when it will not decode.
fn body(conn: &Connection, id: &str, gaps: &mut Gaps) -> Result<Option<String>, StorageError> {
    let rendered = reads::document_of(conn, id).and_then(|document| {
        let blocks = extract_blocks(&document)?;
        let table = |block_id: &str| extract_table(&document, block_id).ok().flatten();
        Ok(body::render(&blocks, &table))
    });
    match rendered {
        Ok(markdown) => Ok(Some(markdown)),
        Err(CrdtError::Storage { source }) => Err(source),
        Err(_) => {
            gaps.unreadable += 1;
            Ok(None)
        }
    }
}

/// The note's cover reference, as desktop writes it under `cover`.
fn cover(cover_json: Option<&str>) -> Option<Field> {
    let cover: Value = serde_json::from_str(cover_json?).ok()?;
    let reference = cover.get("ref")?.as_str()?;
    (!reference.is_empty()).then(|| Field::new("cover", Value::from(reference)))
}

/// A new file: the block, then the body, one trailing newline
/// (`writeMarkdownNote`, `packages/app-core/src/markdown.ts:121`).
fn file(fields: &[Field], body: &str) -> String {
    let block = yaml::block(fields);
    let body = body.trim_end_matches('\n');
    match (block.is_empty(), body.is_empty()) {
        (true, true) => String::new(),
        (true, false) => format!("{body}\n"),
        (false, true) => block,
        (false, false) => format!("{block}{body}\n"),
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)
}

/// Copies `source` to a path nothing holds yet; never overwrites.
fn copy_new(source: &Path, target: &Path) -> io::Result<()> {
    let mut reader = File::open(source)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut writer = OpenOptions::new().write(true).create_new(true).open(target)?;
    io::copy(&mut reader, &mut writer).map(|_| ())
}

/// No path in the message: it reaches the shell's log.
fn write_failed(error: io::Error) -> StorageError {
    StorageError::Failed {
        what: format!("the export could not write a file: {:?}", error.kind()),
    }
}
