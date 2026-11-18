//! `processMetadataJob` (`jobs.ts`): a link's preview (title, description, hero image and the
//! rest of `UrlMetadata`) fetched, scraped and written back, then its article queued.

use memry_core::domain::inbox::jobs::{InboxJob, InboxJobType};
use serde_json::{Map, Value, json};

use super::run::{Ctx, Halt};
use super::{InboxJobNotice, ItemChanges};
use crate::services::web_fetch::{UrlMetadata, is_bot_page_title, is_reddit_url, metascrape};

/// `processMetadataJob`'s message for a capture that is gone or has no URL.
pub(super) const MISSING_LINK: &str = "Link item not found or missing source URL.";

pub(super) fn run(ctx: &Ctx<'_>, job: &InboxJob) {
    let Some(url) = ctx.source_url(&job.item_id) else {
        ctx.fail(job, MISSING_LINK);
        return;
    };
    let outcome = fetch(ctx, &url).and_then(|metadata| store(ctx, job, &url, metadata));
    match outcome {
        Ok(()) | Err(Halt::Stopped) => {}
        Err(Halt::Failed(error)) => failed(ctx, job, &url, &error),
    }
}

/// `fetchUrlMetadata`: Reddit's JSON first for a Reddit link, else the page scraped.
fn fetch(ctx: &Ctx<'_>, url: &str) -> Result<UrlMetadata, Halt> {
    let web = &ctx.jobs.web;
    if is_reddit_url(url)
        && let Some(metadata) = ctx.block(web.reddit_metadata(url))?
    {
        return Ok(metadata);
    }
    let html = ctx
        .block(web.metadata_page(url))?
        .map_err(|error| Halt::Failed(error.to_string()))?;
    let page_url = url.to_owned();
    ctx.off_thread(move || metascrape(&html, &page_url))?
        .map_err(|error| Halt::Failed(error.to_string()))
}

/// The success half of `processMetadataJob`: hero downloaded, preview written, article queued.
fn store(ctx: &Ctx<'_>, job: &InboxJob, url: &str, metadata: UrlMetadata) -> Result<(), Halt> {
    let item_id = job.item_id.as_str();
    let thumbnail_path = match metadata.image.as_deref() {
        Some(image) => {
            let dir = ctx.open.path.join("attachments/inbox").join(item_id);
            ctx.block(ctx.jobs.web.download_image(image, &dir))?
                .map(|name| format!("attachments/inbox/{item_id}/{name}"))
        }
        None => None,
    };
    let title = metadata
        .title
        .clone()
        .filter(|title| !title.is_empty() && !is_bot_page_title(title));
    let description = metadata.description.clone().filter(|d| !d.is_empty());
    ctx.inbox
        .complete_link_with_thumbnail(
            item_id.to_owned(),
            title,
            description,
            preview(url, &metadata).to_string(),
            thumbnail_path.clone(),
        )
        .map_err(|error| Halt::Failed(error.to_string()))?;
    ctx.wrote(
        item_id,
        InboxJobNotice::Updated {
            item_id: item_id.to_owned(),
            changes: ItemChanges {
                processing_status: Some("complete".to_owned()),
                thumbnail_path: thumbnail_path.clone(),
                ..ItemChanges::default()
            },
        },
    );
    ctx.notify(InboxJobNotice::MetadataComplete {
        item_id: item_id.to_owned(),
        title: metadata.title,
        description: metadata.description,
        image: metadata.image,
        thumbnail_path,
    });
    // Queued before the finish: a crash between the two reruns the preview (its write is
    // idempotent) instead of leaving a complete link that never gets its article.
    ctx.enqueue(item_id, InboxJobType::ArticleExtract);
    ctx.finish(job);
    Ok(())
}

/// The stored `metadata`: `jobs.ts` writes each field only when it is not empty.
fn preview(url: &str, metadata: &UrlMetadata) -> Value {
    let mut map = Map::new();
    map.insert("url".into(), json!(url));
    map.insert("fetchStatus".into(), json!("complete"));
    for (key, value) in [
        ("siteName", &metadata.publisher),
        ("description", &metadata.description),
        ("heroImage", &metadata.image),
        ("favicon", &metadata.logo),
        ("author", &metadata.author),
        ("publishedDate", &metadata.date),
    ] {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            map.insert(key.into(), json!(value));
        }
    }
    Value::Object(map)
}

/// The failure half: retried after a delay while attempts remain; the last one marks the
/// capture failed with the URL-derived title it already has.
fn failed(ctx: &Ctx<'_>, job: &InboxJob, url: &str, error: &str) {
    if job.attempts < job.max_attempts {
        ctx.fail(job, error);
        return;
    }
    let item_id = job.item_id.as_str();
    let patch = json!({ "url": url, "fetchStatus": "failed", "error": error });
    match ctx
        .inbox
        .complete_link(item_id.to_owned(), None, None, patch.to_string())
    {
        Ok(_) => ctx.wrote(
            item_id,
            InboxJobNotice::Updated {
                item_id: item_id.to_owned(),
                changes: ItemChanges {
                    processing_status: Some("failed".to_owned()),
                    processing_error: Some(error.to_owned()),
                    ..ItemChanges::default()
                },
            },
        ),
        Err(store) => {
            tracing::warn!(scope = "Inbox:Jobs", error = %store, "a link's failure was not stored");
        }
    }
    ctx.notify(InboxJobNotice::ProcessingError {
        item_id: item_id.to_owned(),
        operation: "metadata",
        error: error.to_owned(),
    });
    ctx.fail(job, error);
}
