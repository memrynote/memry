//! `Inbox` enrichment writes (spec 006 D3, D4): what the shell learned about a
//! capture on this device (a link's preview and article, a voice memo's
//! transcript), written back onto it. Split from `inbox_write.rs`.

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::api::inbox_records::InboxItemRecord;
use crate::api::inbox_write::metadata_object;
use crate::domain::inbox::write;

#[uniffi::export]
impl Inbox {
    /// The on-device link preview's result (D3): never overwrites a richer
    /// value a peer wrote.
    pub fn complete_link(
        &self,
        id: String,
        title: Option<String>,
        description: Option<String>,
        metadata_json: String,
    ) -> Result<InboxItemRecord, StorageError> {
        let patch = metadata_object(Some(&metadata_json))?;
        self.item(move |conn, device, now| {
            write::complete_link(
                conn,
                &id,
                title.as_deref(),
                description.as_deref(),
                &patch,
                device,
                now,
            )
        })
    }

    /// The on-device article extraction's result: `content_markdown` becomes
    /// the capture's content and `metadata_json` (`excerpt`,
    /// `extractionStatus`, `properties`, …) overwrites those keys, as desktop's
    /// article job does.
    pub fn complete_article(
        &self,
        id: String,
        content_markdown: String,
        metadata_json: String,
    ) -> Result<InboxItemRecord, StorageError> {
        let patch = metadata_object(Some(&metadata_json))?;
        self.item(move |conn, device, now| {
            write::complete_article(conn, &id, &content_markdown, &patch, device, now)
        })
    }

    pub fn set_transcription(
        &self,
        id: String,
        transcription: Option<String>,
        status: String,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::set_transcription(conn, &id, transcription.as_deref(), &status, device, now)
        })
    }
}
