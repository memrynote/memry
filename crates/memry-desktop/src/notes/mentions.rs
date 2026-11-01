//! Unlinked mentions (#3320 on Electron, #3530 13i): `notes:get-unlinked-mentions` of desktop
//! `ipc/notes-handlers.ts`, the port of `getUnlinkedMentions` (`vault/unlinked-mentions.ts`).
//!
//! The core names the candidates (`link_reads::mention_sources`: the notes whose indexed text
//! holds every word of one of the target's names, less the target and its backlinks) and owns
//! the exact match (`mention_mask`). This reads each candidate's file the way Electron does, the
//! body after the frontmatter block, and keeps the sources that spell a name unlinked.
//!
//! Not here yet, stated: Electron also leaves out notes that reference the target from a
//! property or embed it as a portal (`getIncomingReferences`); those indexes are not ported, so
//! such a note still lists its plain mentions. A source with no file row (a journal day with no
//! file yet) has no text to read and is left out.

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::domain::link_reads::IncomingLink;
use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::markdown::shared::mention_mask::{find_unlinked_mentions, mention_contexts};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::links::{BacklinkContextView, units};
use crate::session::OpenVault;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::read_note;

const SCOPE: &str = "unlinked_mentions";

/// `UnlinkedMention`. `contexts[i]` is the mention `notes:link-mention` takes as `ordinal` `i`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedMentionView {
    pub source_id: String,
    pub source_path: String,
    pub source_title: String,
    pub contexts: Vec<BacklinkContextView>,
    /// Every mention in the source: more than `contexts` holds when `truncated`.
    pub mention_count: u32,
    /// The source mentions the note so densely that its snippets stopped at the output bound
    /// (`mention_contexts`): `contexts` holds the first ones.
    pub truncated: bool,
}

/// The unlinked mentions of the open vault.
pub struct Mentions {
    root: PathBuf,
    search: Arc<Search>,
}

impl Mentions {
    pub fn new(open: &OpenVault) -> Self {
        Self {
            root: open.path.clone(),
            search: open.search.clone(),
        }
    }

    /// `getUnlinkedMentions`: the notes that spell the note's title or an alias as plain text,
    /// in title order. Empty for a note that is not live.
    pub fn get(&self, id: &str) -> Result<Vec<UnlinkedMentionView>, StorageError> {
        let Some(found) = self.search.mention_sources(id)? else {
            return Ok(Vec::new());
        };
        Ok(found
            .sources
            .into_iter()
            .filter_map(|source| mentions_in(&self.root, source, &found.names))
            .collect())
    }
}

/// The mentions of `names` in `source`'s file, `None` when it holds none or has no text to
/// read. Only a markdown file is read: Electron skips a binary one (`isBinaryFileType`), and a
/// file type this build does not know is skipped with it.
fn mentions_in(root: &Path, source: IncomingLink, names: &[String]) -> Option<UnlinkedMentionView> {
    let path = source.source_path?;
    if file_type_of_extension(&extension(&path)) != Some(FileType::Markdown) {
        return None;
    }
    let raw = match read_note(root, &path) {
        Ok(Some(file)) => file.raw,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                source_id = source.source_id,
                "a mention source was not read: {error}"
            );
            return None;
        }
    };
    let body = split_frontmatter_block(&raw).body;
    let mentions = find_unlinked_mentions(body, names);
    if mentions.is_empty() {
        return None;
    }
    let found = mention_contexts(body, &mentions);
    Some(UnlinkedMentionView {
        source_id: source.source_id,
        source_path: path,
        source_title: source.source_title,
        contexts: found.contexts.into_iter().map(Into::into).collect(),
        mention_count: units(found.count),
        truncated: found.truncated,
    })
}
