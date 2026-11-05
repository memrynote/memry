//! The files the open walk finds. A file a row names goes through [`Applier::found`] at once,
//! or not at all when the row is current. The markdown files no row names are put aside and
//! applied together (#3530 13q-7): a vault the app has never seen is all such files, and one
//! at a time each costs a markdown conversion on the consumer's thread and three commits
//! (record, body, row). Together, the files are read and their bodies authored on several
//! threads, the identity creates their notes with those bodies in one transaction, and their
//! rows go in one more.
//!
//! What a file ends as is what [`Applier::found`] makes of it alone: the same note, a body
//! that is the same feed of the same text, and a row with the same hashes, stamped after the
//! body's commit. Only a markdown file no row names, read whole, that the identity takes for
//! a new note goes this way; every other file put aside, and each one the identity answers
//! `false` for, goes back to the walk, which applies it through [`Applier::found`] with its
//! own hold of the lane, as any file it finds. A crash between the two transactions leaves
//! notes without rows whose bodies are their files' text, which the next open adopts by
//! folder and title, as it does after a crash between a create and its seed.

use std::collections::HashSet;
use std::num::NonZero;

use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::external_feed::{FeedInput, FirstBody};
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_stat,
};

use super::apply::{Applier, Step};
use super::body::writing_of;
use super::converter_for;
use super::identity::{Candidate, NewFile};
use super::rows::{Lane, RowStat};
use super::{Applied, ChangeSource};
use crate::vault::activity::{ScanActivity, failure_key};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::{NoteFile, read_note};
use crate::vault::path_key::folded_key;
use crate::vault::watch::reconcile::modified_ms;

const SCOPE: &str = "vault_consumer";

/// Threads the reads and conversions of files applied together use, at most.
const THREADS: usize = 8;

/// A markdown file no row names, as the walk found it.
pub(super) struct Found {
    pub(super) path: String,
    pub(super) size: u64,
    modified_ms: i64,
}

/// What [`Applier::found_together`] did: the steps of the files it applied, and the files the
/// walk applies alone.
pub(super) struct Together {
    pub(super) steps: Vec<(String, Step)>,
    pub(super) alone: Vec<Found>,
}

/// What the open walk did with a file.
pub(super) enum Walked {
    Applied(Step),
    /// Put aside for [`Applier::found_together`].
    New(Found),
}

impl Applier {
    /// A file the open walk found. Goes through the same handler as a watcher's `Added`. A
    /// row whose size is the file's and that was written after the file's last modification
    /// is not read again, as the rescan does: reading every file costs a vault-sized read. A
    /// markdown row is, unless both its hashes name the same bytes: one without a content hash
    /// (its text never reached the note), and one whose file hash is missing or names other
    /// bytes (a row an older build wrote, or one salvaged), which the read mends. A markdown
    /// file no row names is put aside. What the activity log is told goes into `scan`.
    pub(super) fn walked(
        &self,
        path: &str,
        meta: &std::fs::Metadata,
        scan: &mut ScanActivity,
    ) -> Walked {
        let Some(file_type) = file_type_of_extension(&extension(path)) else {
            return Walked::Applied(Step::Done);
        };
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Walked::Applied(Step::Done);
        };
        let modified = modified_ms(meta);
        match lane.row_at(path) {
            Ok(Some(row)) => {
                scan.known += 1;
                if row.file_size == i64::try_from(meta.len()).ok()
                    && modified <= row.indexed_at
                    && (file_type != FileType::Markdown
                        || (row.content_hash.is_some() && row.file_hash == row.content_hash))
                {
                    return Walked::Applied(Step::Done);
                }
            }
            Ok(None) if file_type == FileType::Markdown => {
                return Walked::New(Found {
                    path: path.to_owned(),
                    size: meta.len(),
                    modified_ms: modified,
                });
            }
            Ok(None) | Err(_) => {}
        }
        let step = self.found(&mut lane, path, file_type, meta.len(), modified, Some(scan));
        Walked::Applied(step)
    }

    /// Applies the new notes of the files the walk put aside together, and answers the rest
    /// for the walk to apply alone ([`Self::found_alone`]), each with its own hold of the lane:
    /// an app operation waiting for the lane gets it between two of them. The files are read
    /// and their bodies authored before the lane is taken, and the lane is held only for the
    /// two transactions and the facts.
    pub(super) fn found_together(&self, found: Vec<Found>, scan: &mut ScanActivity) -> Together {
        let prepared = match &self.feed {
            Some(feed) if found.len() > 1 && self.identity.adopts() => self.prepare(feed, found),
            _ => {
                return Together {
                    steps: Vec::new(),
                    alone: found,
                };
            }
        };
        let (with_body, without): (Vec<Prepared>, Vec<Prepared>) =
            prepared.into_iter().partition(|p| p.body.is_some());
        let mut alone: Vec<Found> = without.into_iter().map(|p| p.found).collect();
        let mut steps = Vec::new();
        if !with_body.is_empty() {
            match self.rows.lane_of(self.session) {
                Ok(mut lane) => {
                    let (new, back) = new_files(&lane, with_body);
                    alone.extend(back);
                    alone.extend(self.create(&mut lane, new, scan, &mut steps));
                }
                Err(_) => alone.extend(with_body.into_iter().map(|p| p.found)),
            }
        }
        Together { steps, alone }
    }

    /// A file the walk put aside, applied alone as [`Self::walked`] applies a file.
    pub(super) fn found_alone(&self, file: Found, scan: &mut ScanActivity) -> Step {
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Step::Done;
        };
        self.found(
            &mut lane,
            &file.path,
            FileType::Markdown,
            file.size,
            file.modified_ms,
            Some(scan),
        )
    }

    /// Reads the files and authors the body of each the identity may take for a new note.
    fn prepare(&self, feed: &ExternalFeed, found: Vec<Found>) -> Vec<Prepared> {
        // A file that does not read goes alone, which reads it again and reports why. One whose
        // size alone makes it large-file class is not a new note's and goes alone unread, so a
        // batch holds at most the large-file size (1 MiB) per file.
        let thresholds = MarkdownClassThresholds::default();
        let read: Vec<Option<NoteFile>> = in_parallel(&found, |file| {
            let large = usize::try_from(file.size).map_or(true, |size| {
                classify_markdown_stat(size, thresholds).is_some()
            });
            (!large)
                .then(|| read_note(&self.root, &file.path).ok().flatten())
                .flatten()
        });
        for (file, _) in found.iter().zip(&read).filter(|(_, read)| read.is_some()) {
            self.activity
                .release(&self.root, &failure_key("read-failed", &file.path));
        }
        let candidates: Vec<Candidate<'_>> = found
            .iter()
            .zip(&read)
            .map(|(file, read)| file.candidate(read.as_ref()))
            .collect();
        let may_be_new = self.identity.may_be_new(&self.ctx(), &candidates);
        let converter = converter_for(self.settings.as_ref());
        let files = self.vault.note_files();
        let asked: Vec<(&Found, Option<&NoteFile>, bool)> = found
            .iter()
            .zip(&read)
            .zip(may_be_new)
            .map(|((file, read), may_be_new)| (file, read.as_ref(), may_be_new))
            .collect();
        let bodies: Vec<Option<(String, FirstBody)>> =
            in_parallel(&asked, |&(found, file, may_be_new)| {
                let file = file.filter(|_| may_be_new)?;
                let id = NotesWriter::new_note_id();
                let split = file.split();
                let embeds = Resolved::of_markdown(&self.root, &files, split.body, &found.path);
                let input = FeedInput {
                    note_id: &id,
                    markdown: split.body,
                    note_path: Some(&found.path),
                    writing: writing_of(file),
                    frontmatter: split.block,
                    embeds: Some(&embeds),
                };
                Some((id.clone(), feed.first_body(&converter, input)?))
            });
        found
            .into_iter()
            .zip(read)
            .zip(bodies)
            .map(|((found, read), body)| Prepared { found, read, body })
            .collect()
    }

    /// Creates the notes of `new` the identity takes, records their rows and publishes them;
    /// answers the files it sent back.
    fn create(
        &self,
        lane: &mut Lane<'_>,
        new: Vec<Prepared>,
        scan: &mut ScanActivity,
        steps: &mut Vec<(String, Step)>,
    ) -> Vec<Found> {
        let mut created = vec![false; new.len()];
        let files: Vec<NewFile<'_>> = new
            .iter()
            .filter_map(|prepared| {
                let (id, body) = prepared.body.as_ref()?;
                Some(NewFile {
                    candidate: prepared.found.candidate(prepared.read.as_ref()),
                    id,
                    body,
                })
            })
            .collect();
        if !files.is_empty() {
            match self.identity.adopt_new_files(&self.ctx(), &files) {
                Ok(answers) => {
                    let mut answers = answers.into_iter();
                    for (at, prepared) in new.iter().enumerate() {
                        if prepared.body.is_some() {
                            created[at] = answers.next().unwrap_or(false);
                        }
                    }
                }
                Err(error) => {
                    tracing::error!(scope = SCOPE, "new files got no notes together: {error}");
                }
            }
        }
        let (made, back): (Vec<_>, Vec<_>) = new
            .into_iter()
            .zip(created)
            .partition(|(_, created)| *created);
        self.record(
            lane,
            made.into_iter().map(|(p, _)| p).collect(),
            scan,
            steps,
        );
        back.into_iter()
            .map(|(prepared, _)| prepared.found)
            .collect()
    }

    /// The rows of the notes `made`, in one transaction, then their facts. Rows that are not
    /// recorded are retried: the file is offered again and adopts its note, which no row names.
    ///
    /// The rows are stamped when they are written, after the body's commit, as the one-file
    /// path stamps them: the write-back takes a body entry stamped after its row for an edit
    /// its file has not had (`note_files::behind_bodies`), and the search index's watermark
    /// needs stamps in the order they are written. Stamped before the read, a row would fall
    /// behind its own first body, and the write-back would write that body over an edit the
    /// file took after the read. That edit reaches the note as the one-file path's does: the
    /// watcher reports the file, which is not the bytes its row names.
    fn record(
        &self,
        lane: &mut Lane<'_>,
        made: Vec<Prepared>,
        scan: &mut ScanActivity,
        steps: &mut Vec<(String, Step)>,
    ) {
        let mut rows = Vec::with_capacity(made.len());
        for prepared in &made {
            let (Some(read), Some((id, _))) = (&prepared.read, &prepared.body) else {
                continue;
            };
            let stat = RowStat {
                file_type: FileType::Markdown,
                size: prepared.found.size,
                content_hash: Some(read.hash.clone()),
                file_hash: Some(read.hash.clone()),
            };
            rows.push((id.clone(), prepared.found.path.clone(), stat));
        }
        if let Err(error) = lane.put_all(rows) {
            tracing::error!(scope = SCOPE, "new notes' rows were not recorded: {error}");
            for prepared in made {
                let path = prepared.found.path;
                steps.push((path.clone(), Step::Retry(path)));
            }
            return;
        }
        for prepared in made {
            let (Some((id, _)), path) = (prepared.body, prepared.found.path) else {
                continue;
            };
            lane.publish(Applied::Added {
                note_id: id,
                path: path.clone(),
                created: true,
                source: ChangeSource::Walk,
            });
            self.report_found(&path, true, Some(scan));
            steps.push((path, Step::Done));
        }
    }
}

/// A file put aside, read, with the id and body its new note is to get when the identity may
/// take it for one.
struct Prepared {
    found: Found,
    read: Option<NoteFile>,
    body: Option<(String, FirstBody)>,
}

impl Found {
    fn candidate<'a>(&'a self, file: Option<&'a NoteFile>) -> Candidate<'a> {
        Candidate {
            path: &self.path,
            file_type: FileType::Markdown,
            size: self.size,
            modified_ms: self.modified_ms,
            file,
        }
    }
}

/// The files with a body to create that no row names under any spelling, nor another of these
/// files, while the lane is held; the rest go alone.
fn new_files(lane: &Lane<'_>, prepared: Vec<Prepared>) -> (Vec<Prepared>, Vec<Found>) {
    let mut keys = HashSet::new();
    let (new, alone): (Vec<Prepared>, Vec<Prepared>) = prepared.into_iter().partition(|prepared| {
        let path = &prepared.found.path;
        prepared.body.is_some()
            && matches!(lane.row_at(path), Ok(None))
            && lane.check_free(path).is_ok()
            && keys.insert(folded_key(path))
    });
    (new, alone.into_iter().map(|p| p.found).collect())
}

/// `work` over `items` on up to [`THREADS`] threads, in order.
fn in_parallel<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map_or(1, NonZero::get)
        .min(THREADS);
    let chunk = items.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = items
            .chunks(chunk)
            .map(|part| scope.spawn(|| part.iter().map(&work).collect::<Vec<R>>()))
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}
