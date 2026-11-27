//! The first file of a note or journal day that no row names (#3534 L5b): a record pulled from
//! another device, whose file Electron writes on pull (`note-handler.ts` `generateNotePath` and
//! `generateUniquePathSync`, `journal-handler.ts` the day's path).
//!
//! - **Where.** A note goes in its folder, else the vault root (not the default note folder, as
//!   Electron), under the first name no row holds and nothing on disk stands at:
//!   `<title>.md`, then `<title> 1.md` and on ([`free_path`]). A day goes at its day's path; a
//!   day path that is taken keeps the day unfiled ([`Keep::PathTaken`]), since what stands there
//!   is the identity's to adopt.
//! - **What.** The frontmatter Electron's pull writes (the tags, other names and properties, a
//!   day's date first and its reserved keys left out, then a note's cover keys), then the body
//!   as the pass writes it ([`output_over`]). A body not pulled yet writes nothing: the pull that
//!   brings it schedules the note again.
//! - **A day waits**, as a local day create refuses, while the vault's settings cannot be read
//!   (their defaults do not say where the journal is) or a journal setting change or a moved
//!   journal folder holds the days ([`Keep::DayWaits`]); the next open lists it again.
//! - **Order**, as a local create's, under the rows' lane: the row with no hash, the write told
//!   to the own-write record, the file created and never written over, then the row's hashes
//!   stamped as a pass stamps them.
//! - **Not before the open walk ends**: a file on disk may be the note's and have no row yet. The
//!   reconcile after the walk lists every unfiled note again.

use memry_core::domain::note_files::{StampMark, Unfiled};
use memry_core::markdown::frontmatter::{YamlMap, YamlValue, json_to_yaml, write_markdown_note};
use memry_core::markdown::shared::cover_image::{COVER_FRONTMATTER_KEY, cover_frontmatter};

use super::pass::output_over;
use super::{Keep, Outcome, Pass};
use crate::journal::write::{day_file, day_frontmatter};
use crate::journal::{day_path_in, is_reserved_day_key};
use crate::notes::create::{free_path, remove_row};
use crate::notes::error::NotesError;
use crate::notes::frontmatter::{is_reserved_key, new_file_frontmatter};
use crate::vault::config::read_vault_config_strict;
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
        between: &mut dyn FnMut(),
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
        let output = match output_over(made, note_id, &rel, &file, None) {
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
        between();
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
                match self.vault.note_files().days_wait() {
                    Ok(false) => {}
                    Ok(true) => return Err(Outcome::Kept(Keep::DayWaits)),
                    Err(error) => return Err(Outcome::Failed(format!("the held days: {error}"))),
                }
                let Ok(config) = read_vault_config_strict(root) else {
                    return Err(Outcome::Kept(Keep::DayWaits));
                };
                let rel = day_path_in(&config, date)
                    .map_err(|error| Outcome::Broken(format!("the day's path: {error}")))?;
                let taken =
                    lane.check_free(&rel).is_err() || root.join(&rel).symlink_metadata().is_ok();
                if taken {
                    return Err(Outcome::Kept(Keep::PathTaken));
                }
                let mut properties = unfiled.properties.clone();
                properties.retain(|name, value| {
                    !is_reserved_day_key(name) && !is_reserved_key(name, value)
                });
                let mut frontmatter = day_frontmatter(date, &unfiled.tags, &properties);
                with_aliases(
                    &mut frontmatter,
                    unfiled.aliases.as_deref().unwrap_or_default(),
                );
                (rel, day_file(&frontmatter, ""))
            }
            None => {
                let folder = unfiled
                    .folder_path
                    .as_deref()
                    .filter(|folder| !folder.is_empty());
                // A read error may pass (a folder's permissions, a busy disk): tried again.
                let rel = free_path(lane, root, root, &unfiled.title, folder).map_err(|error| {
                    let reason = format!("no path for the note: {error}");
                    match error {
                        NotesError::Io(_) => Outcome::Failed(reason),
                        _ => Outcome::Broken(reason),
                    }
                })?;
                let mut frontmatter = new_file_frontmatter(&unfiled.tags, &unfiled.properties);
                with_aliases(
                    &mut frontmatter,
                    unfiled.aliases.as_deref().unwrap_or_default(),
                );
                // A `cover` property that is no cover is the user's; a remote cover never
                // replaces it (`applyNoteCoverToFrontmatter`).
                let cover = unfiled.cover.as_ref().map(cover_frontmatter);
                if !frontmatter.contains_key(COVER_FRONTMATTER_KEY) {
                    for (key, value) in cover.into_iter().flatten() {
                        frontmatter.insert(key.to_owned(), json_to_yaml(&value));
                    }
                }
                (rel, write_markdown_note(&frontmatter, ""))
            }
        };
        let written =
            written.map_err(|error| Outcome::Broken(format!("the frontmatter: {error}")))?;
        Ok((rel, written))
    }
}

/// The record's other names, as a kept note's file holds them (`notes::kept` `file_text`).
fn with_aliases(frontmatter: &mut YamlMap, aliases: &[String]) {
    if !aliases.is_empty() {
        let items = aliases.iter().cloned().map(YamlValue::String);
        frontmatter.insert("aliases".to_owned(), YamlValue::seq(items.collect()));
    }
}
