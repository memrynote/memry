//! `Inbox` article writes (`domain::inbox::ingest`): the browser extension's
//! capture and the article-extract job. Split from `inbox_write.rs`
//! (600-line ceiling).

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::api::inbox_records::InboxItemRecord;
use crate::domain::inbox::ingest::{self, InboxArticle, InboxArticleFiles};

#[uniffi::export]
impl Inbox {
    /// A new capture `item_id` from an article whose files the shell stored
    /// under `attachments/inbox/<item_id>/` (mint the id with `new_id`).
    /// `tags` `nil` gives `clippings`.
    pub fn capture_article(
        &self,
        item_id: String,
        article: InboxArticle,
        files: InboxArticleFiles,
        tags: Option<Vec<String>>,
        capture_source: String,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            ingest::capture_article(
                conn,
                &item_id,
                &article,
                &files,
                tags.as_deref(),
                &capture_source,
                device,
                now,
            )
        })
    }

    /// The live capture `item_id` enriched with an article; `hero_path` is
    /// the downloaded hero under its folder, if any.
    pub fn enrich_article(
        &self,
        item_id: String,
        article: InboxArticle,
        hero_path: Option<String>,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            ingest::enrich_article(conn, &item_id, &article, hero_path.as_deref(), device, now)
        })
    }
}
