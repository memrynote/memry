//! Desktop's link reads on [`Search`].

use crate::api::errors::StorageError;
use crate::domain::link_reads::{self, Incoming, LinkTarget, MentionSources};
use crate::domain::notes::link_rewrite::LinkNames;
use crate::domain::unlinked_mentions;

use super::Search;

/// Desktop's link reads ([`link_reads`]). Not on the FFI surface: they answer in desktop's
/// shapes (file paths, `getIncomingLinks`'s resolved-id match).
impl Search {
    /// The notes and journal days whose links resolved to `target_id` ([`link_reads::incoming`]).
    pub fn incoming_links(&self, target_id: &str) -> Result<Incoming, StorageError> {
        let target_id = target_id.to_owned();
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| link_reads::incoming(data, index, &target_id))
        })
    }

    /// The notes and days whose links may name the note once called `from`
    /// ([`link_reads::rewrite_sources`]).
    pub fn link_rewrite_sources(
        &self,
        target_id: &str,
        from: &LinkNames,
    ) -> Result<Vec<String>, StorageError> {
        let (target_id, from) = (target_id.to_owned(), from.clone());
        self.index
            .read_blocking(move |index| link_reads::rewrite_sources(index, &target_id, &from))
    }

    /// The notes and days that may mention `target_id` unlinked ([`link_reads::mention_sources`]).
    pub fn mention_sources(&self, target_id: &str) -> Result<Option<MentionSources>, StorageError> {
        let target_id = target_id.to_owned();
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| link_reads::mention_sources(data, index, &target_id))
        })
    }

    /// The names a mention of `target_id` spells: its title (a day's date), then its aliases,
    /// as [`Search::mention_sources`] lists them. Empty when the target is not live.
    pub fn mention_names(&self, target_id: &str) -> Result<Vec<String>, StorageError> {
        let target_id = target_id.to_owned();
        self.data
            .read_blocking(move |data| unlinked_mentions::target_names(data, &target_id))
    }

    /// What each of `queries` names as a whole ([`link_reads::resolve_titles`]).
    pub fn resolve_link_titles(
        &self,
        queries: Vec<String>,
    ) -> Result<Vec<Option<LinkTarget>>, StorageError> {
        self.data
            .read_blocking(move |data| link_reads::resolve_titles(data, &queries))
    }

    /// What a wiki-link target names, with its heading ([`link_reads::resolve_target`]).
    pub fn resolve_link_target(
        &self,
        target: &str,
    ) -> Result<Option<(LinkTarget, Option<String>)>, StorageError> {
        let target = target.to_owned();
        self.data
            .read_blocking(move |data| link_reads::resolve_target(data, &target))
    }
}
