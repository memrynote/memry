//! A note's links, and the note a wiki link names (#3530 13i): `notes:get-links`,
//! `notes:resolve-by-title`, `notes:resolve-titles` and `notes:resolve-wiki-target` of desktop
//! `ipc/notes-handlers.ts`, in their shapes.
//!
//! The core answers which notes link where and which note a name resolves to
//! (`memry_core::domain::link_reads`), in a fixed number of statements. This adds what only the
//! vault holds: the text around each link, read from the linking note's file the way
//! `getNoteLinks` reads it (comments stripped, `link_contexts`), and the file path a
//! resolution names.
//!
//! Not here yet, stated: Electron's backlinks also list relation properties, portals and
//! canvas arrows (`LinkVia`); the core has no index of those for desktop. A source that links
//! to the note under two spellings is listed once (`note_links` holds a row per spelling, and
//! Electron listed each). A journal day is a source with text once a file row names it
//! (13m); a day with none is listed at the path the journal settings give it, with no text.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::domain::link_reads::{IncomingLink, LinkTarget};
use memry_core::markdown::shared::link_contexts::{LinkContexts, link_contexts};
use memry_core::markdown::shared::markdown_code::strip_markdown_comments;
use serde::Serialize;

use crate::session::OpenVault;
use crate::shell::file_open::is_plain_segment;
use crate::vault::config::read_vault_config;
use crate::vault::file_types::FileType;
use crate::vault::journal_format::{
    JournalDate, format_journal_filename, normalize_journal_folder,
};
use crate::vault::note_file::read_note;

const SCOPE: &str = "note_links";

/// A link the note makes (`NoteLink`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkView {
    pub source_id: String,
    /// `None` for a broken link.
    pub target_id: Option<String>,
    pub target_title: String,
}

/// A link's text in the linking note (`BacklinkContext`); offsets are UTF-16 units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkContextView {
    pub snippet: String,
    pub link_start: u32,
    pub link_end: u32,
}

/// A note linking to this one (`Backlink`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkView {
    pub source_id: String,
    pub source_path: String,
    pub source_title: String,
    pub contexts: Vec<BacklinkContextView>,
    /// Every link to the note in the source's file: Electron's `contexts.length`, which the
    /// panel counts and sorts by. More than `contexts` holds when `truncated`.
    pub mention_count: u32,
    /// The file links so densely that its snippets stopped at the output bound
    /// (`link_contexts`): `contexts` holds the first ones.
    pub truncated: bool,
}

/// `NoteLinksResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinksView {
    pub outgoing: Vec<NoteLinkView>,
    pub incoming: Vec<BacklinkView>,
}

/// `WikiLinkResolution`, and `WikiLinkTargetResolution` with `heading`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkResolutionView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub file_type: FileType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkTargetView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub file_type: FileType,
    /// The heading to scroll to, `None` when the link names none.
    pub heading: Option<String>,
}

/// One entry of `WikiLinkTitleResolutions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TitleMatchView {
    pub id: String,
    pub path: String,
}

/// The links of the open vault.
pub struct NoteLinks {
    root: PathBuf,
    search: Arc<Search>,
}

impl NoteLinks {
    pub fn new(open: &OpenVault) -> Self {
        Self {
            root: open.path.clone(),
            search: open.search.clone(),
        }
    }

    /// `getNoteLinks`: the links the note makes, resolved now, and the notes linking to it with
    /// the text around each link. Empty for a note that is not live.
    pub fn get(&self, id: &str) -> Result<NoteLinksView, StorageError> {
        let outgoing = self
            .search
            .links_from(id.to_owned())?
            .into_iter()
            .map(|link| NoteLinkView {
                source_id: id.to_owned(),
                target_id: link.target_id,
                target_title: link.target_title,
            })
            .collect();
        let incoming = self.search.incoming_links(id)?;
        let title = incoming.target_title.unwrap_or_default();
        let incoming = incoming
            .sources
            .into_iter()
            .map(|source| self.backlink(source, &title))
            .collect();
        Ok(NoteLinksView { outgoing, incoming })
    }

    fn backlink(&self, source: IncomingLink, target_title: &str) -> BacklinkView {
        let found = match &source.source_path {
            Some(path) if !target_title.is_empty() => self.contexts(path, target_title, &source),
            _ => LinkContexts::default(),
        };
        BacklinkView {
            source_path: source
                .source_path
                .clone()
                .or_else(|| {
                    source
                        .source_date
                        .as_deref()
                        .and_then(|d| self.journal_path(d))
                })
                .unwrap_or_default(),
            source_id: source.source_id,
            source_title: source.source_title,
            contexts: found
                .contexts
                .into_iter()
                .map(|context| BacklinkContextView {
                    snippet: context.snippet,
                    link_start: units(context.link_start),
                    link_end: units(context.link_end),
                })
                .collect(),
            mention_count: units(found.count),
            truncated: found.truncated,
        }
    }

    /// The links to `title` in the whole file at `path`, frontmatter included and comments
    /// stripped, as `getNoteLinks` reads it. A file that cannot be read keeps its backlink with
    /// no text: the panel still names the note, and the log says why.
    fn contexts(&self, path: &str, title: &str, source: &IncomingLink) -> LinkContexts {
        match read_note(&self.root, path) {
            Ok(Some(file)) => link_contexts(&strip_markdown_comments(&file.raw), title),
            Ok(None) => LinkContexts::default(),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    source_id = source.source_id,
                    "a backlink's text was not read: {error}"
                );
                LinkContexts::default()
            }
        }
    }

    /// `resolveLinkTarget`: what `title` names as a whole, without a heading split.
    pub fn resolve_by_title(
        &self,
        title: &str,
    ) -> Result<Option<LinkResolutionView>, StorageError> {
        Ok(self
            .search
            .resolve_link_titles(vec![title.to_owned()])?
            .pop()
            .flatten()
            .map(|target| {
                let (id, path, title, file_type) = self.named(target);
                LinkResolutionView {
                    id,
                    path,
                    title,
                    file_type,
                }
            }))
    }

    /// `resolveLinkTargets`: every distinct title once, each with its match or `None`.
    pub fn resolve_titles(
        &self,
        titles: Vec<String>,
    ) -> Result<BTreeMap<String, Option<TitleMatchView>>, StorageError> {
        let mut distinct = titles;
        distinct.sort();
        distinct.dedup();
        let found = self.search.resolve_link_titles(distinct.clone())?;
        Ok(distinct
            .into_iter()
            .zip(found)
            .map(|(title, target)| {
                let found = target.map(|target| {
                    let (id, path, _, _) = self.named(target);
                    TitleMatchView { id, path }
                });
                (title, found)
            })
            .collect())
    }

    /// `notes:resolve-wiki-target`: the split note half first, then the raw string.
    pub fn resolve_wiki_target(
        &self,
        target: &str,
    ) -> Result<Option<LinkTargetView>, StorageError> {
        Ok(self
            .search
            .resolve_link_target(target)?
            .map(|(target, heading)| {
                let (id, path, title, file_type) = self.named(target);
                LinkTargetView {
                    id,
                    path,
                    title,
                    file_type,
                    heading,
                }
            }))
    }

    /// The id, path, title and file type of a resolution. A note with no file row (one synced
    /// here whose file is not written yet) is named where its file goes, `folder/Title.md`,
    /// when every segment is a plain name; a journal day where the vault's journal settings
    /// put it.
    ///
    /// A file type a newer build stored reads as markdown, as Electron reads a missing one
    /// (`fileType ?? 'markdown'`): the link still opens its note.
    fn named(&self, target: LinkTarget) -> (String, String, String, FileType) {
        let path = target
            .path
            .clone()
            .or_else(|| match &target.journal_date {
                Some(date) => self.journal_path(date),
                None => planned_path(&target),
            })
            .unwrap_or_default();
        let file_type = FileType::of_stored(&target.file_type).unwrap_or(FileType::Markdown);
        (target.id, path, target.title, file_type)
    }

    /// `getJournalPath`: the day's file under the journal folder, in the journal date format.
    fn journal_path(&self, date: &str) -> Option<String> {
        let config = read_vault_config(&self.root);
        let file =
            format_journal_filename(JournalDate::from_iso(date)?, &config.journal_date_format);
        let folder = normalize_journal_folder(&config.journal_folder);
        Some(if folder.is_empty() {
            format!("{file}.md")
        } else {
            format!("{folder}/{file}.md")
        })
    }
}

fn planned_path(target: &LinkTarget) -> Option<String> {
    if target.file_type != "markdown" {
        return None;
    }
    let file = format!("{}.md", target.title);
    let folder = target.folder_path.as_deref().unwrap_or_default();
    let segments: Vec<&str> = folder
        .split('/')
        .filter(|segment| !segment.is_empty())
        .chain([file.as_str()])
        .collect();
    segments
        .iter()
        .all(|segment| is_plain_segment(segment))
        .then(|| segments.join("/"))
}

fn units(offset: usize) -> u32 {
    u32::try_from(offset).unwrap_or(u32::MAX)
}
