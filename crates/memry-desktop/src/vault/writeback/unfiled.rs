//! The first file of a note or journal day that no row names (#3534 L5b): a record pulled from
//! another device, whose file Electron writes on pull (`note-handler.ts` `generateNotePath` and
//! `generateUniquePathSync`, `journal-handler.ts` the day's path).
//!
//! - **Where.** A note goes in its folder, else the vault root (not the default note folder, as
//!   Electron), under the first name no row holds and nothing on disk stands at:
//!   `<title>.md`, then `<title> 1.md` and on ([`free_path`]). A day goes at its day's path; a
//!   day path that is taken keeps the day unfiled ([`Keep::PathTaken`]), since what stands there
//!   is the identity's to adopt.
//! - **What.** The frontmatter a local create writes (the tags and properties, a day's date
//!   first), then the body as the pass writes it ([`output_over`]). A body not pulled yet writes
//!   nothing: the pull that brings it schedules the note again.
//! - **Order**, as a local create's, under the rows' lane: the row with no hash, the write told
//!   to the own-write record, the file created and never written over, then the row's hashes
//!   stamped as a pass stamps them.
//! - **Not before the open walk ends**: a file on disk may be the note's and have no row yet. The
//!   reconcile after the walk lists every unfiled note again.

use memry_core::domain::note_files::{StampMark, Unfiled};
use memry_core::markdown::frontmatter::write_markdown_note;

use super::pass::output_over;
use super::{Keep, Outcome, Pass};
use crate::journal::day_path;
use crate::journal::write::{day_file, day_frontmatter};
use crate::notes::create::{free_path, remove_row};
use crate::notes::frontmatter::new_file_frontmatter;
use crate::vault::consumer::rows::{Lane, RowStat};
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{
    NoteFile, NoteFileError, large_file_class, record_large_file, write_new_text,
};

impl Pass {
    /// Writes the first file of `note_id`, which no row names, or says why it was kept.
    pub(super) fn file_unfiled(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        stamp: (i64, StampMark),
    ) -> Outcome {
        if !self.rows.walked(&self.vault) {
            return Outcome::Kept(Keep::NoRow);
        }
        let unfiled = match self.vault.note_files().unfiled(note_id) {
            Ok(Some(unfiled)) => unfiled,
            Ok(None) => return Outcome::Kept(Keep::NoRow),
            Err(error) => return Outcome::Failed(format!("the unfiled record: {error}")),
        };
        let (rel, skeleton) = match self.first_file(lane, &unfiled) {
            Ok(first) => first,
            Err(outcome) => return outcome,
        };
        let file = NoteFile {
            hash: content_hash(&skeleton),
            raw: skeleton,
        };
        let made = (&*self.vault, self.settings.as_ref(), self.root.as_path());
        let output = match output_over(made, note_id, &rel, &file) {
            Ok(output) => output,
            Err(outcome) => return outcome,
        };
        let hash = content_hash(&output);
        let unseeded = RowStat {
            file_type: FileType::Markdown,
            size: 0,
            content_hash: None,
            file_hash: None,
        };
        if let Err(error) = lane.put(note_id, &rel, unseeded) {
            return Outcome::Failed(format!("the new file's row: {error}"));
        }
        self.echo.will_write(&rel, &hash);
        if let Err(error) = write_new_text(&self.root, &rel, &output) {
            // Not this pass's file: what stands there now is someone else's.
            self.echo.cancel_write(&rel);
            remove_row(lane, note_id);
            return match error {
                NoteFileError::AlreadyExists => Outcome::Kept(Keep::PathTaken),
                error => Outcome::Failed(format!("the new file was not written: {error}")),
            };
        }
        record_large_file(lane.files(), note_id, large_file_class(&output).is_some());
        self.own_files.wrote_back(note_id, &hash);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put_as_of(note_id, &rel, stat, stamp) {
            // A row with no hash beside the file: the next open walk reads the file, which is
            // the body's text, and records its hash.
            return Outcome::Failed(format!("the file was written, its row was not: {error}"));
        }
        lane.publish(Applied::Added {
            note_id: note_id.to_owned(),
            path: rel.clone(),
            created: true,
            source: ChangeSource::App,
        });
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: rel,
            content_hash: Some(hash.clone()),
            source: ChangeSource::App,
        });
        Outcome::Wrote {
            hash,
            version_kept: false,
            replaced_outside: false,
        }
    }

    /// The vault-relative path of the record's first file, and that file before its body.
    fn first_file(&self, lane: &Lane<'_>, unfiled: &Unfiled) -> Result<(String, String), Outcome> {
        let root = self.root.as_path();
        let (rel, written) = match &unfiled.date {
            Some(date) => {
                let rel = day_path(root, date)
                    .map_err(|error| Outcome::Failed(format!("the day's path: {error}")))?;
                let taken =
                    lane.check_free(&rel).is_err() || root.join(&rel).symlink_metadata().is_ok();
                if taken {
                    return Err(Outcome::Kept(Keep::PathTaken));
                }
                let frontmatter = day_frontmatter(date, &unfiled.tags, &unfiled.properties);
                (rel, day_file(&frontmatter, ""))
            }
            None => {
                let folder = unfiled
                    .folder_path
                    .as_deref()
                    .filter(|folder| !folder.is_empty());
                let rel = free_path(lane, root, root, &unfiled.title, folder)
                    .map_err(|error| Outcome::Failed(format!("no path for the note: {error}")))?;
                let frontmatter = new_file_frontmatter(&unfiled.tags, &unfiled.properties);
                (rel, write_markdown_note(&frontmatter, ""))
            }
        };
        let written =
            written.map_err(|error| Outcome::Failed(format!("the frontmatter: {error}")))?;
        Ok((rel, written))
    }
}
