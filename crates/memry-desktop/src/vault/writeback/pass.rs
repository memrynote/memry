//! One write-back pass for one note; the rules are the module invariants.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_core::api::vault::Vault;
use memry_core::domain::app_settings::AppSettings;
use memry_core::domain::external_feed::same_text;
use memry_core::domain::note_files::StampMark;
use memry_core::domain::note_snapshots;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::frontmatter::{
    ParsedMarkdownNote, YamlMap, YamlValue, serialize_parsed_markdown_note, split_frontmatter_block,
};
use memry_core::markdown::shared::writing_tools::{WritingFrontmatter, merge_writing_yaml};
use memry_core::seams::secure_store::SecureStore;

use super::journal::{Dated, dated_block, set_date};
use super::place::{Found, Mark, Patch, Pulled, header_tags_of, patch};
use crate::attachments;
use crate::locks::Locks;
use crate::vault::app_edit::OwnFiles;
use crate::vault::consumer::rows::{RowOwner, RowSession, RowStat, now_ms};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{
    NoteFile, NoteFileError, large_file_class, read_note, record_large_file,
    write_note_over_checked,
};
use crate::vault::watch::EchoGuard;

const BOM: char = '\u{feff}';

/// What a pass came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The file now holds the body. `version_kept` when the replaced file was kept first.
    /// `replaced_outside` when the write replaced an outside edit the consumer read
    /// ([`OwnFiles`]), which a version holds: the signal to tell the user. `version_kept` alone
    /// is also true for the app's own write of ten words or more, and for a file of an earlier
    /// run.
    Wrote {
        hash: String,
        version_kept: bool,
        replaced_outside: bool,
    },
    /// The file already holds the body, byte for byte.
    Unchanged,
    Kept(Keep),
    /// The pass could not finish (a read or a write failed); the file is as it was, unless
    /// the reason says the row was not recorded after the write.
    Failed(String),
    /// The pass cannot finish, and runs of it fail the same way until the note, its file or the
    /// app changes: a body that does not read, a file that does not serialize, no path for a first
    /// file, a pass that panicked. Told as a failed write, and not retried on its own.
    Broken(String),
    /// The file's frontmatter does not parse: its block is bytes the document does not hold,
    /// so the file is never written over, and no later pass writes it until the file is fixed
    /// (#3750). The user is told, as for a failure.
    FrontmatterUnreadable(String),
}

/// Why the file was kept as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keep {
    /// The vault session of this pass is over.
    Closed,
    /// No row names the note's file, and none was made: the note is gone, or the open walk
    /// has not ended (`unfiled`).
    NoRow,
    /// The path of a day's first file is taken (`unfiled`).
    PathTaken,
    /// A day's first file is not named now: the vault's settings cannot be read, or a journal
    /// setting change or a moved journal folder holds the days (`unfiled`).
    DayWaits,
    NotMarkdown,
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
    /// What the write-back and the app's other writers wrote this run, and the outside edits the
    /// consumer read.
    pub(super) own_files: Arc<OwnFiles>,
    /// Reaches the notes writer, for a pulled place's move (`place`).
    pub(super) store: Arc<dyn SecureStore>,
    /// The notes a pull changed whose pass has not taken the change yet (`place`).
    pub(super) pulled: Pulled,
    /// The days whose file a pass left off its date's path this session, logged once
    /// (`day_place`).
    pub(super) refused_days: Mutex<HashSet<String>>,
}

impl Pass {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: PathBuf,
        vault: Arc<Vault>,
        rows: Arc<RowOwner>,
        session: RowSession,
        echo: Arc<EchoGuard>,
        settings: Option<AppSettings>,
        own_files: Arc<OwnFiles>,
        store: Arc<dyn SecureStore>,
    ) -> Self {
        Self {
            root,
            vault,
            rows,
            session,
            echo,
            settings,
            own_files,
            store,
            pulled: Pulled::default(),
            refused_days: Mutex::default(),
        }
    }

    /// A pull changed the note: its next pass gives its file the record's place and frontmatter
    /// (`place`). `title_before` is its title before the pull: the file is renamed only when
    /// the pulled title differs from it.
    pub fn mark_pulled(&self, note_id: &str, title_before: Option<&str>) {
        self.pulled.mark(note_id, title_before);
    }

    /// Writes the note's body to its file, or says why the file was kept.
    pub fn run(&self, note_id: &str) -> Outcome {
        self.run_checked(note_id, &mut || {})
    }

    /// [`Pass::run`] with a hook that runs after the new file is written aside and before the
    /// checks ahead of its rename, or before a first file is created (`unfiled`), so a test can
    /// edit or move the file in that window.
    #[doc(hidden)]
    pub fn run_checked(&self, note_id: &str, between: &mut dyn FnMut()) -> Outcome {
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Outcome::Kept(Keep::Closed);
        };
        // The row's stamp and its log mark: taken before the body is read, so an edit made
        // after the read is after the stamp and the note stays behind its body (`reconcile`).
        let read_at = now_ms();
        let read_mark = match self.vault.write_back().body_mark(note_id) {
            Ok(mark) => StampMark::At(mark),
            Err(error) => return Outcome::Failed(format!("the body's log mark: {error}")),
        };
        let row = match lane.files().by_id(note_id) {
            Ok(Some(row)) => row,
            Ok(None) => {
                let outcome = self.file_unfiled(&mut lane, note_id, (read_at, read_mark), between);
                // The first file takes the record's place and frontmatter.
                if matches!(outcome, Outcome::Wrote { .. } | Outcome::Unchanged) {
                    self.pulled.take(note_id);
                }
                return outcome;
            }
            Err(error) => return Outcome::Failed(format!("note_files: {error}")),
        };
        // No file to place, or one never placed: a mark kept would make a later local pass a
        // pulled one. A row not read yet keeps it, as a file changed since its hash does: the
        // pass after the read places the file.
        if row.file_type != FileType::Markdown.as_str() {
            self.pulled.take(note_id);
            return Outcome::Kept(Keep::NotMarkdown);
        }
        let Some(row_hash) = row.content_hash.clone() else {
            return Outcome::Kept(Keep::NotRead);
        };
        let file = match read_note(&self.root, &row.path) {
            Ok(Some(file)) => file,
            Ok(None) => {
                self.pulled.take(note_id);
                return Outcome::Kept(Keep::NoFile);
            }
            Err(error) => return Outcome::Failed(format!("the file could not be read: {error}")),
        };
        if file.hash != row_hash {
            return Outcome::Kept(Keep::FileChanged);
        }
        // A live day's file stands at its date's path (`day_place`, #5786).
        let day_place = self.place_day(&mut lane, &row);
        // A pulled change: taken here, and given back to the next pass when this one stops.
        let pulled = match self.pulled.take(note_id) {
            None => None,
            Some(mark) => match self.vault.note_files().placed(note_id) {
                Ok(record) => record.map(|record| (mark, record)),
                Err(error) => {
                    self.pulled.put_back(note_id, mark);
                    return Outcome::Failed(format!("the pulled record: {error}"));
                }
            },
        };
        // The mark a pass that keeps the file gives back, so the pass after the wait (a body
        // not pulled yet, #5509) still gives the file the pulled change; a pass that wrote it
        // gives it back only for a failed move to be tried again.
        let mut waiting = pulled.as_ref().map(|(mark, _)| mark.clone());
        let mut move_again = false;
        let wait = |waiting: Option<Mark>, move_again: bool, outcome: Outcome| {
            let wrote = matches!(outcome, Outcome::Wrote { .. } | Outcome::Unchanged);
            // A deleted note's mark goes: one that comes back is pulled again.
            let gone = outcome == Outcome::Kept(Keep::NoNote);
            if let Some(mark) = waiting.filter(|_| !gone && (!wrote || move_again)) {
                self.pulled.put_back(note_id, mark);
            }
            outcome
        };
        let mut moved = day_place.is_some();
        let mut path = day_place.unwrap_or_else(|| row.path.clone());
        // A day's path is its date's (`day_place`): a pulled record never places it.
        let places = pulled
            .as_ref()
            .zip(waiting.as_mut())
            .filter(|((mark, record), _)| record.date.is_none() && mark.moves());
        if let Some(((mark, record), waiting)) = places {
            let found = Found {
                path: &row.path,
                file_hash: row.file_hash.as_deref(),
            };
            let title_before = mark.title_before.as_deref();
            match self.place(&mut lane, note_id, &found, (record, title_before)) {
                Ok(Some(new)) => (path, moved) = (new, true),
                Ok(None) => {}
                // The file and its row stay where they were, and the body is written there: a
                // move that cannot happen never holds the file back from the note's edits.
                Err(why) => {
                    waiting.move_failed(note_id, &why);
                    move_again = waiting.moves();
                }
            }
        }
        let pulled = pulled.as_ref().map(|(_, record)| record);
        let patch = pulled.map(|record| Patch {
            record,
            types: self.property_types(),
        });
        let made = (&*self.vault, self.settings.as_ref(), self.root.as_path());
        let output = match output_over(made, note_id, &path, &file, patch.as_ref()) {
            Ok(output) => output,
            Err(outcome) => return wait(waiting, move_again, outcome),
        };
        let patched = pulled.is_some()
            && split_frontmatter_block(&file.raw).block != split_frontmatter_block(&output).block;
        // Electron's `applyUpsert` sends a `sync` `notes:updated` for every pulled place or
        // frontmatter it gives the file.
        let source = match moved || patched {
            true => ChangeSource::Sync,
            false => ChangeSource::App,
        };
        if output == file.raw {
            let stat = RowStat {
                file_type: FileType::Markdown,
                size: file.raw.len() as u64,
                content_hash: Some(row_hash.clone()),
                file_hash: Some(row_hash),
            };
            if let Err(error) = lane.put_as_of(note_id, &path, stat, (read_at, read_mark)) {
                // The file is right; the note is behind once more on the next open, whose
                // pass finds it unchanged again.
                tracing::warn!(
                    scope = "vault_writeback",
                    note_id,
                    "the row was not stamped: {error}"
                );
            }
            if moved {
                lane.publish(Applied::Changed {
                    note_id: note_id.to_owned(),
                    path,
                    content_hash: Some(file.hash),
                    source,
                });
            }
            return wait(waiting, move_again, Outcome::Unchanged);
        }
        let hash = content_hash(&output);
        let kept = self.keep_replaced(note_id, &file.raw, &file.hash, &output, patched);
        let (version_kept, replaced_outside) = match kept {
            Ok(kept) => kept,
            Err(error) => {
                return wait(
                    waiting,
                    move_again,
                    Outcome::Failed(format!("no version of the replaced file was kept: {error}")),
                );
            }
        };
        self.echo.will_write(&path, &hash);
        // A locked note's document takes only another device's edits (the core refuses local
        // ones), so its write-back goes through the lock, and its text becomes the baseline.
        let written = Locks::new(&self.root, &self.vault).write_through(&path, &output, || {
            write_note_over_checked(&self.root, &path, &output, &file.hash, between)
        });
        match written {
            // A writer of bytes the run did not write may still be writing the file replaced.
            Ok(replaced) if !self.own_files.ours(note_id, &file.hash) => {
                let told = Applied::OutsideEditKept {
                    note_id: note_id.to_owned(),
                    path: path.clone(),
                };
                replaced.keep_late_writes(&self.vault, &self.rows, note_id, told);
            }
            Ok(_) => {}
            Err(NoteFileError::ChangedUnderWrite) => {
                return wait(waiting, move_again, Outcome::Kept(Keep::FileChanged));
            }
            Err(error) => {
                return wait(
                    waiting,
                    move_again,
                    Outcome::Failed(format!("the file was not written: {error}")),
                );
            }
        }
        // An attachment rename the body carries moves the file on this device too (#1714).
        attachments::reconcile_renames(&self.root, &self.vault, note_id, &file.raw, &output);
        // A body grown past the class (typed, merged) makes the note a large file: the editor
        // stops taking edits, as Electron's write-back degrades the note. Recorded before the
        // row, so a row write that fails leaves no large file the editor still takes edits of.
        record_large_file(lane.files(), note_id, large_file_class(&output).is_some());
        self.own_files.wrote_back(note_id, &hash);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put_as_of(note_id, &path, stat, (read_at, read_mark)) {
            // The file holds the document's body and the row the old hash, so the next pass
            // reads it as an outside edit and keeps it. The feed (12e-3b) reads it back
            // `Unchanged` and records the hash; until then the file only waits.
            return wait(
                waiting,
                move_again,
                Outcome::Failed(format!("the file was written, its row was not: {error}")),
            );
        }
        if let Some(record) = pulled.filter(|_| patched) {
            self.wrote_pulled(note_id, record);
        }
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.clone(),
            content_hash: Some(hash.clone()),
            source,
        });
        if patched && header_tags_of(&file.raw) != header_tags_of(&output) {
            lane.publish(Applied::TagsPulled {
                note_id: note_id.to_owned(),
            });
        }
        // The one signal of outside text a version holds now: never `version_kept`, which the
        // app's own writes raise too.
        if replaced_outside {
            lane.publish(Applied::OutsideEditKept {
                note_id: note_id.to_owned(),
                path,
            });
        }
        wait(
            waiting,
            move_again,
            Outcome::Wrote {
                hash,
                version_kept,
                replaced_outside,
            },
        )
    }

    /// Keeps the file a write replaces when the write changes bytes the document does not hold
    /// ([`replaces_unheld_bytes`]) and the file is not what this run wrote last for the note
    /// (this write-back, or another writer of the app: [`OwnFiles`]), or, when it is, when the
    /// body moves by ten words or more
    /// ([`note_snapshots::is_significant`], Electron's `keepVersionBeforeWriteback`). Answers
    /// whether a version was written, and whether the replaced bytes are an outside edit the
    /// consumer read (then a version holds them, newly kept or kept before). An error stops the write: the
    /// replaced file is the only copy of those bytes.
    fn keep_replaced(
        &self,
        note_id: &str,
        raw: &str,
        hash: &str,
        output: &str,
        pulled_frontmatter: bool,
    ) -> Result<(bool, bool), String> {
        if !replaces_unheld_bytes(raw, output) {
            return Ok((false, false));
        }
        let ours = self.own_files.ours(note_id, hash);
        let body = split_frontmatter_block(raw).body;
        // A pulled frontmatter rewrite always keeps the file it replaces first (#5309).
        if ours
            && !pulled_frontmatter
            && !note_snapshots::is_significant(body, split_frontmatter_block(output).body)
        {
            return Ok((false, false));
        }
        // Bytes the run did not write are an outside edit the body took, or a file of an
        // earlier run: kept as an outside write, they rotate only significant versions, as the
        // consumer's and the lock's outside keeps do (#4250).
        let write_back = self.vault.write_back();
        let kept = if ours {
            write_back.keep_replaced(note_id, raw, body)
        } else {
            write_back.keep_outside_write(note_id, raw, body)
        };
        let outside = !ours && self.own_files.is_outside(note_id, hash);
        Ok((kept.map_err(|error| error.to_string())?, outside))
    }
}

/// The file the note's body makes of `file`, the note's file at `path`, as a pass writes it;
/// `Err` with the pass's outcome when the body is not written over it.
pub(crate) fn output_over(
    (vault, settings, root): (&Vault, Option<&AppSettings>, &Path),
    note_id: &str,
    path: &str,
    file: &NoteFile,
    pulled: Option<&Patch<'_>>,
) -> Result<String, Outcome> {
    // A journal day's file takes the day's date in its frontmatter (`journal`).
    let file_date = match vault.write_back().file_date(note_id) {
        Ok(date) => date,
        Err(error) => return Err(Outcome::Failed(format!("the journal day: {error}"))),
    };
    // A block that does not parse is bytes the document does not hold, and the row may name
    // such a file (`vault::consumer`): it is never written over.
    let parsed = match file.parse() {
        Ok(parsed) => parsed,
        Err(error) => return Err(Outcome::FrontmatterUnreadable(error.to_string())),
    };
    let old_body = file.split().body;
    let converter = converter_for(settings);
    // Outside the read: the lookup reads the database the read holds.
    let embeds = Resolved::of_markdown(root, &vault.note_files(), old_body, path);
    let read = vault.write_back().body(
        &converter,
        note_id,
        path,
        Some(old_body.strip_prefix(BOM).unwrap_or(old_body)),
        &embeds,
    );
    let body = match read {
        Ok(BodyRead::Body(body)) => body,
        Ok(BodyRead::NoNote) => return Err(Outcome::Kept(Keep::NoNote)),
        Ok(BodyRead::FileAhead) => return Err(Outcome::Kept(Keep::FileAhead)),
        Ok(BodyRead::BodyNotPulled) => return Err(Outcome::Kept(Keep::BodyNotPulled)),
        Ok(BodyRead::NotRepresentable(what)) => {
            return Err(Outcome::Kept(Keep::NotRepresentable(what)));
        }
        Ok(BodyRead::Failed(reason)) => return Err(Outcome::Broken(reason.to_owned())),
        Err(error) => {
            return Err(Outcome::Failed(format!(
                "the body could not be read: {error}"
            )));
        }
    };
    // The same text in the file's spelling (mixed line ends, extra final newlines) is the
    // file's: the document does not hold the spelling, so the file keeps it.
    let bare = old_body.strip_prefix(BOM).unwrap_or(old_body);
    let markdown = if same_text(&body.markdown, bare) {
        old_body
    } else {
        body.markdown.as_str()
    };
    file_for(
        parsed,
        markdown,
        &body.writing,
        &file.raw,
        (note_id, file_date.as_deref()),
        pulled,
    )
    .map_err(Outcome::Broken)
}

/// The file the body makes of `parsed`: its frontmatter block kept byte for byte unless the
/// `writing` data changed it, or, for `note_id` a journal day whose file carries `file_date`,
/// its `date` entry (`journal`); its line ends, and the byte order mark of `raw`.
fn file_for(
    mut parsed: ParsedMarkdownNote,
    markdown: &str,
    writing: &WritingFrontmatter,
    raw: &str,
    (note_id, file_date): (&str, Option<&str>),
    pulled: Option<&Patch<'_>>,
) -> Result<String, String> {
    // A file with no block takes a pulled frontmatter as an empty map.
    if pulled.is_some() && parsed.raw_frontmatter_block.is_none() {
        parsed.frontmatter = YamlValue::map(YamlMap::new());
    }
    let edited = match &parsed.frontmatter {
        YamlValue::Map(map) => {
            let mut merged: YamlMap = (**map).clone();
            let patched =
                pulled.is_some_and(|pulled| patch(&mut merged, pulled.record, raw, &pulled.types));
            let edited = merge_writing_yaml(&mut merged, writing) | patched;
            if edited {
                if let Some(date) = file_date {
                    set_date(&mut merged, date);
                }
                parsed.frontmatter = YamlValue::map(merged);
            }
            edited
        }
        // A top level that is a list or a scalar is the author's; no key is added to it.
        _ => false,
    };
    // The date rides on a write of the body; it never writes a file on its own.
    if !edited
        && markdown != parsed.content
        && let Some(date) = file_date
    {
        match dated_block(&parsed, raw, date) {
            Dated::Says => {}
            Dated::Set(block) => parsed.raw_frontmatter_block = Some(block),
            Dated::NotInPlace(why) => tracing::warn!(
                scope = "vault_writeback",
                note_id,
                "a journal day's file is written without the day's date: {why}"
            ),
        }
    }
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
