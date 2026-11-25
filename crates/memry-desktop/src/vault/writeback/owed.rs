//! A note's file that owes its record's `aliases` ([`memry_core::domain::owed_file_aliases`]):
//! the record was newer than the file when the file was first named, and kept its list. The
//! pass writes the file's `aliases` key alone (`place::owed_aliases`): through a normal pass for
//! a note's file, and for a large-file class file, whose body the note does not hold, by
//! replacing its frontmatter block alone and copying the body's bytes as they are
//! ([`replace_head_checked`], #5825). Once the file holds the list the debt is paid.
//!
//! A large file's write keeps the pass's guards: the row's file hash names the file, the file
//! hashed again right before the rename, the own-write record told first, the row recorded
//! after. It keeps no version: the bytes it replaces are the stale `aliases` lines alone, and a
//! version of a large file would copy the whole body for them.

use memry_core::domain::note_files::{NoteFile as Row, StampMark, Unfiled};
use memry_core::domain::notes::EditedAliases;

use super::Pass;
use super::pass::{Keep, Outcome};
use super::place::owed_aliases;
use crate::locks::Locks;
use crate::notes::identity::aliases::declared;
use crate::vault::consumer::rows::{Lane, RowStat};
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::file_types::FileType;
use crate::vault::note_file::{NoteFileError, hash_file};
use crate::vault::note_head::{Head, read_head, replace_head_checked};

/// What stands for the body after a head given to the frontmatter writer: it is never
/// touched, so the new head is the written text before it.
const BODY: &str = "\u{1}";

impl Pass {
    /// The record whose `aliases` the note's file owes; `None` when it owes none.
    pub(super) fn owed_record(&self, note_id: &str) -> Result<Option<Unfiled>, String> {
        let files = self.vault.note_files();
        match files.owes_file_aliases(note_id) {
            Ok(false) => Ok(None),
            Ok(true) => files
                .placed(note_id)
                .map_err(|error| format!("the record owed to the file: {error}")),
            Err(error) => Err(format!("the aliases owed to the file: {error}")),
        }
    }

    /// The file holds its record's aliases: the debt is paid. A debt not cleared is paid again
    /// by a later pass, which finds the file unchanged.
    pub(super) fn paid(&self, note_id: &str) {
        if let Err(error) = self.vault.note_files().clear_owed_file_aliases(note_id) {
            tracing::warn!(
                scope = "vault_writeback",
                note_id,
                "the aliases the file owed are written, the debt stays: {error}"
            );
        }
    }

    /// The pass of a large-file class note whose file owes its record's aliases; `None` for any
    /// other note, which the normal pass takes.
    pub(super) fn owed_large(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        row: &Row,
        read: (i64, StampMark),
        between: &mut dyn FnMut(),
    ) -> Option<Outcome> {
        match lane.files().is_large_file(note_id) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(error) => return Some(Outcome::Failed(format!("the file's class: {error}"))),
        }
        let record = match self.owed_record(note_id) {
            Ok(Some(record)) => record,
            Ok(None) => return None,
            Err(why) => return Some(Outcome::Failed(why)),
        };
        Some(self.write_large(lane, note_id, row, &record, read, between))
    }

    fn write_large(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        row: &Row,
        record: &Unfiled,
        read: (i64, StampMark),
        between: &mut dyn FnMut(),
    ) -> Outcome {
        let path = row.path.as_str();
        let Some(row_hash) = row.file_hash.as_deref() else {
            return Outcome::Kept(Keep::NotRead);
        };
        let head = match read_head(&self.root, path) {
            Ok(Some(head)) => head,
            Ok(None) => return Outcome::Kept(Keep::NoFile),
            Err(error) => return Outcome::Failed(format!("the file's head: {error}")),
        };
        match hash_file(&self.root, path) {
            Ok(Some(hash)) if hash == row_hash => {}
            Ok(Some(_)) => return Outcome::Kept(Keep::FileChanged),
            Ok(None) => return Outcome::Kept(Keep::NoFile),
            Err(error) => return Outcome::Failed(format!("the file could not be read: {error}")),
        }
        // Invariant: the write never replaces a list the debt did not record. The head's list is
        // settled first: one an outside edit changed, which a large file's re-read does not
        // measure (REVIEW-5836), is the user's answer, taken by the record, and the debt is
        // cleared. Only the list the file had when it came to owe the record's is written over.
        if let Some(declared) = declared(head.block.then_some(head.text.as_str())) {
            let settled = self
                .vault
                .notes_writer(self.store.clone())
                .map_err(|error| error.to_string())
                .and_then(|writer| {
                    writer
                        .edited_file_aliases(note_id, declared.as_deref())
                        .map_err(|error| error.to_string())
                });
            match settled {
                Ok(EditedAliases::Owed) => {}
                Ok(EditedAliases::Taken | EditedAliases::NoNote) => return Outcome::Unchanged,
                Err(error) => return Outcome::Failed(format!("the file's aliases: {error}")),
            }
        }
        let new = match new_head(&head, record) {
            Ok(Some(new)) => new,
            Ok(None) => {
                self.paid(note_id);
                return Outcome::Unchanged;
            }
            Err(why) => return Outcome::Failed(why),
        };
        match Locks::new(&self.root, &self.vault).is_path_locked(path) {
            Ok(false) => {}
            Ok(true) => {
                return Outcome::Failed(
                    "a locked large file keeps its aliases until it is unlocked".to_owned(),
                );
            }
            Err(error) => return Outcome::Failed(format!("the file's lock: {error}")),
        }
        let mut told = |hash: &str| {
            self.echo.will_write(path, hash);
            between();
        };
        let (hash, size) =
            match replace_head_checked(&self.root, path, (&head, &new), row_hash, &mut told) {
                Ok(written) => written,
                Err(NoteFileError::ChangedUnderWrite) => return Outcome::Kept(Keep::FileChanged),
                Err(error) => return Outcome::Failed(format!("the file was not written: {error}")),
            };
        self.own_files.wrote_back(note_id, &hash);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size,
            content_hash: None,
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put_as_of(note_id, path, stat, read) {
            return Outcome::Failed(format!("the file was written, its row was not: {error}"));
        }
        self.paid(note_id);
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            content_hash: None,
            source: ChangeSource::App,
        });
        Outcome::Wrote {
            hash,
            version_kept: false,
            replaced_outside: false,
        }
    }
}

/// The head that gives the file whose head is `head` the record's `aliases`; `None` when it
/// holds them already.
fn new_head(head: &Head, record: &Unfiled) -> Result<Option<String>, String> {
    // A block that ends the file without a line break is closed, so the new block follows it.
    let block = match head.block {
        true if !head.text.ends_with('\n') => format!("{}\n", head.text),
        true => head.text.clone(),
        false => String::new(),
    };
    let given = format!("{block}{BODY}");
    let written = owed_aliases(given.clone(), record)?;
    if written == given {
        return Ok(None);
    }
    let Some(block) = written.strip_suffix(BODY) else {
        return Err("the aliases did not leave the body as it is".to_owned());
    };
    // A byte order mark ahead of a file with no block stays first.
    Ok(Some(match head.block {
        true => block.to_owned(),
        false => format!("{}{block}", head.text),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn newer() -> Unfiled {
        Unfiled {
            title: "Dump".to_owned(),
            folder_path: None,
            date: None,
            tags: Vec::new(),
            aliases: Some(vec!["Newer".to_owned()]),
            properties: serde_json::Map::new(),
            cover: None,
        }
    }

    /// REVIEW-5836: a block that ends the file with no line break gets the list in it, never
    /// a second block ahead of it.
    #[test]
    fn a_block_ending_the_file_without_a_line_break_gets_no_second_block() {
        let head = Head {
            text: "---\ntags: [mine]\naliases: [Old]\n---".to_owned(),
            block: true,
        };
        assert_eq!(
            new_head(&head, &newer()).unwrap().as_deref(),
            Some("---\ntags: [mine]\naliases:\n  - Newer\n---\n")
        );
    }
}
