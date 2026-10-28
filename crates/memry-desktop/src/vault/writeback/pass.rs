//! One write-back pass for one note; the rules are the module invariants.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_core::api::vault::Vault;
use memry_core::domain::app_settings::AppSettings;
use memry_core::domain::external_feed::same_text;
use memry_core::domain::journal::valid_date;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::frontmatter::{
    ParsedMarkdownNote, YamlMap, YamlValue, serialize_parsed_markdown_note, split_frontmatter_block,
};
use memry_core::markdown::shared::writing_tools::{WritingFrontmatter, merge_writing_yaml};

use crate::vault::consumer::rows::{RowOwner, RowSession, RowStat, now_ms};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{NoteFileError, read_note, write_note_over_checked};
use crate::vault::watch::EchoGuard;

const BOM: char = '\u{feff}';

/// What a pass came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The file now holds the body. `version_kept` when the replaced file was kept first.
    Wrote {
        hash: String,
        version_kept: bool,
    },
    /// The file already holds the body, byte for byte.
    Unchanged,
    Kept(Keep),
    /// The pass could not finish (a read or a write failed); the file is as it was, unless
    /// the reason says the row was not recorded after the write.
    Failed(String),
}

/// Why the file was kept as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keep {
    /// The vault session of this pass is over.
    Closed,
    NoRow,
    NotMarkdown,
    /// A journal note (12e-3c).
    Journal,
    /// The row names a file that is not there.
    NoFile,
    /// The row has no hash: the document is not known to hold the file.
    NotRead,
    /// The file differs from its row's hash, or changed while the write ran.
    FileChanged,
    /// The file holds an edit the document did not take (owed or refused).
    FileAhead,
    /// The note's server body has not been pulled.
    BodyNotPulled,
    /// Writing would lose content; the nodes the schema cannot build, when those are it.
    NotRepresentable(Vec<String>),
    /// No live note by that id.
    NoNote,
}

/// Everything a pass needs, for one vault session.
pub struct Pass {
    pub(crate) root: PathBuf,
    pub(crate) vault: Arc<Vault>,
    pub(crate) rows: Arc<RowOwner>,
    pub(crate) session: RowSession,
    pub(crate) echo: Arc<EchoGuard>,
    pub(crate) settings: Option<AppSettings>,
    /// The hash of the bytes this session's write-back last wrote, per note.
    last_written: Mutex<HashMap<String, String>>,
}

impl Pass {
    pub fn new(
        root: PathBuf,
        vault: Arc<Vault>,
        rows: Arc<RowOwner>,
        session: RowSession,
        echo: Arc<EchoGuard>,
        settings: Option<AppSettings>,
    ) -> Self {
        Self {
            root,
            vault,
            rows,
            session,
            echo,
            settings,
            last_written: Mutex::default(),
        }
    }

    /// Writes the note's body to its file, or says why the file was kept.
    pub fn run(&self, note_id: &str) -> Outcome {
        self.run_checked(note_id, &mut || {})
    }

    /// [`Pass::run`] with a hook that runs after the new file is written aside and before the
    /// checks ahead of its rename, so a test can edit or move the file in that window.
    #[doc(hidden)]
    pub fn run_checked(&self, note_id: &str, between: &mut dyn FnMut()) -> Outcome {
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Outcome::Kept(Keep::Closed);
        };
        // The row's stamp: taken before the body is read, so an edit made after the read is
        // after the stamp and the note stays behind its body (`reconcile`).
        let read_at = now_ms();
        if is_journal(note_id) {
            return Outcome::Kept(Keep::Journal);
        }
        let row = match lane.files().by_id(note_id) {
            Ok(Some(row)) => row,
            Ok(None) => return Outcome::Kept(Keep::NoRow),
            Err(error) => return Outcome::Failed(format!("note_files: {error}")),
        };
        if row.file_type != FileType::Markdown.as_str() {
            return Outcome::Kept(Keep::NotMarkdown);
        }
        let Some(row_hash) = row.content_hash else {
            return Outcome::Kept(Keep::NotRead);
        };
        let file = match read_note(&self.root, &row.path) {
            Ok(Some(file)) => file,
            Ok(None) => return Outcome::Kept(Keep::NoFile),
            Err(error) => return Outcome::Failed(format!("the file could not be read: {error}")),
        };
        if file.hash != row_hash {
            return Outcome::Kept(Keep::FileChanged);
        }
        let parsed = match file.parse() {
            Ok(parsed) => parsed,
            Err(error) => {
                return Outcome::Failed(format!("the frontmatter does not parse: {error}"));
            }
        };
        let old_body = file.split().body;
        let converter = converter_for(self.settings.as_ref());
        let read = self.vault.write_back().body(
            &converter,
            note_id,
            &row.path,
            old_body.strip_prefix(BOM).unwrap_or(old_body),
        );
        let body = match read {
            Ok(BodyRead::Body(body)) => body,
            Ok(BodyRead::NoNote) => return Outcome::Kept(Keep::NoNote),
            Ok(BodyRead::FileAhead) => return Outcome::Kept(Keep::FileAhead),
            Ok(BodyRead::BodyNotPulled) => return Outcome::Kept(Keep::BodyNotPulled),
            Ok(BodyRead::NotRepresentable(what)) => {
                return Outcome::Kept(Keep::NotRepresentable(what));
            }
            Ok(BodyRead::Failed(reason)) => return Outcome::Failed(reason.to_owned()),
            Err(error) => return Outcome::Failed(format!("the body could not be read: {error}")),
        };
        // The same text in the file's spelling (mixed line ends, extra final newlines) is the
        // file's: the document does not hold the spelling, so the file keeps it.
        let bare = old_body.strip_prefix(BOM).unwrap_or(old_body);
        let markdown = if same_text(&body.markdown, bare) {
            old_body
        } else {
            body.markdown.as_str()
        };
        let output = match file_for(parsed, markdown, &body.writing, &file.raw) {
            Ok(output) => output,
            Err(reason) => return Outcome::Failed(reason),
        };
        if output == file.raw {
            let stat = RowStat {
                file_type: FileType::Markdown,
                size: file.raw.len() as u64,
                content_hash: Some(row_hash),
            };
            if let Err(error) = lane.put_as_of(note_id, &row.path, stat, read_at) {
                // The file is right; the note is behind once more on the next open, whose
                // pass finds it unchanged again.
                tracing::warn!(
                    scope = "vault_writeback",
                    note_id,
                    "the row was not stamped: {error}"
                );
            }
            return Outcome::Unchanged;
        }
        let hash = content_hash(&output);
        let version_kept = match self.keep_replaced(note_id, &file.raw, &file.hash, &output) {
            Ok(kept) => kept,
            Err(error) => {
                return Outcome::Failed(format!(
                    "no version of the replaced file was kept: {error}"
                ));
            }
        };
        self.echo.will_write(&row.path, &hash);
        match write_note_over_checked(&self.root, &row.path, &output, &file.hash, between) {
            Ok(()) => {}
            Err(NoteFileError::ChangedUnderWrite) => return Outcome::Kept(Keep::FileChanged),
            Err(error) => return Outcome::Failed(format!("the file was not written: {error}")),
        }
        self.last_written
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(note_id.to_owned(), hash.clone());
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put_as_of(note_id, &row.path, stat, read_at) {
            // The file holds the document's body and the row the old hash, so the next pass
            // reads it as an outside edit and keeps it. The feed (12e-3b) reads it back
            // `Unchanged` and records the hash; until then the file only waits.
            return Outcome::Failed(format!("the file was written, its row was not: {error}"));
        }
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path,
            content_hash: Some(hash.clone()),
            source: ChangeSource::App,
        });
        Outcome::Wrote { hash, version_kept }
    }

    /// Keeps the file a write replaces when the write changes bytes the document does not hold
    /// ([`replaces_unheld_bytes`]) and the file is not what this session last wrote for the
    /// note. `Ok(true)` when a version was written. An error stops the write: the replaced
    /// file is the only copy of those bytes.
    fn keep_replaced(
        &self,
        note_id: &str,
        raw: &str,
        hash: &str,
        output: &str,
    ) -> Result<bool, String> {
        if !replaces_unheld_bytes(raw, output) {
            return Ok(false);
        }
        let ours = self
            .last_written
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(note_id)
            .is_some_and(|last| last == hash);
        if ours {
            return Ok(false);
        }
        self.vault
            .write_back()
            .keep_replaced(note_id, raw, split_frontmatter_block(raw).body)
            .map_err(|error| error.to_string())
    }
}

/// The file the body makes of `parsed`: its frontmatter block kept byte for byte unless the
/// `writing` data changed it, its line ends, and the byte order mark of `raw`.
fn file_for(
    mut parsed: ParsedMarkdownNote,
    markdown: &str,
    writing: &WritingFrontmatter,
    raw: &str,
) -> Result<String, String> {
    let edited = match &parsed.frontmatter {
        YamlValue::Map(map) => {
            let mut merged: YamlMap = (**map).clone();
            let edited = merge_writing_yaml(&mut merged, writing);
            if edited {
                parsed.frontmatter = YamlValue::map(merged);
            }
            edited
        }
        // A top level that is a list or a scalar is the author's; no key is added to it.
        _ => false,
    };
    let mut output = serialize_parsed_markdown_note(&parsed, markdown, edited)
        .map_err(|error| format!("the frontmatter could not be written: {error}"))?;
    if raw.starts_with(BOM) && !output.starts_with(BOM) {
        output.insert(0, BOM);
    }
    Ok(output)
}

/// Whether writing `output` over `raw` changes bytes the document does not hold: the body as
/// the file spells it, or the frontmatter block, which the document holds only the `writing`
/// data of.
pub(super) fn replaces_unheld_bytes(raw: &str, output: &str) -> bool {
    let (old, new) = (
        split_frontmatter_block(raw),
        split_frontmatter_block(output),
    );
    old.block != new.block || old.body != new.body
}

fn is_journal(note_id: &str) -> bool {
    note_id
        .strip_prefix('j')
        .is_some_and(|date| valid_date(date).is_ok())
}
