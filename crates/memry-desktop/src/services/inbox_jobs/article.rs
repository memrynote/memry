//! `processArticleExtractJob` (`jobs.ts`): the link's page fetched again, its readable article
//! extracted (Step 26) and written onto the capture with its hero image (`ingestArticleCapture`,
//! enrich path).

use memry_core::domain::inbox::ingest::{
    InboxArticle, InboxArticleProperties, InboxExtractionStatus,
};
use memry_core::domain::inbox::jobs::InboxJob;

use super::metadata::MISSING_LINK;
use super::run::{Ctx, Halt};
use super::{InboxJobNotice, ItemChanges};
use crate::services::web_fetch::BlockingFetcher;
use crate::web::extract::{ArticleCapture, ExtractionStatus, extract_article};

pub(super) fn run(ctx: &Ctx<'_>, job: &InboxJob) {
    let Some(url) = ctx.source_url(&job.item_id) else {
        ctx.fail(job, MISSING_LINK);
        return;
    };
    match extract(ctx, &url).and_then(|capture| store(ctx, job, capture)) {
        Ok(()) | Err(Halt::Stopped) => {}
        Err(Halt::Failed(error)) => {
            if job.attempts >= job.max_attempts {
                tracing::warn!(scope = "Inbox:Jobs", %error, "Article extraction failed after final attempt");
            }
            ctx.fail(job, &error);
        }
    }
}

/// `fetchUrlHtml` then `extractFromHtml`. The extractors' own requests block the parse thread
/// on the shared runtime.
fn extract(ctx: &Ctx<'_>, url: &str) -> Result<ArticleCapture, Halt> {
    let web = &ctx.jobs.web;
    let html = ctx
        .block(web.article_html(url))?
        .map_err(|error| Halt::Failed(error.to_string()))?;
    let fetcher = BlockingFetcher::new(web.clone(), ctx.jobs.runtime.clone());
    let page_url = url.to_owned();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    ctx.off_thread(move || extract_article(&html, &page_url, &now, &fetcher))
}

fn store(ctx: &Ctx<'_>, job: &InboxJob, capture: ArticleCapture) -> Result<(), Halt> {
    if capture.extraction_status == ExtractionStatus::Failed {
        tracing::warn!(scope = "InboxJobs", "article_extract_status_failed");
        ctx.finish(job);
        return Ok(());
    }
    let item_id = job.item_id.as_str();
    let hero_path = match capture.hero_image.as_deref() {
        Some(hero) => {
            let dir = ctx.open.path.join("attachments/inbox").join(item_id);
            ctx.block(ctx.jobs.web.download_image(hero, &dir))?
                .map(|name| format!("attachments/inbox/{item_id}/{name}"))
        }
        None => None,
    };
    let content = capture.content_markdown.clone();
    ctx.inbox
        .enrich_article(item_id.to_owned(), article(capture), hero_path)
        .map_err(|error| Halt::Failed(error.to_string()))?;
    ctx.wrote(
        item_id,
        InboxJobNotice::Updated {
            item_id: item_id.to_owned(),
            changes: ItemChanges {
                content: Some(content),
                ..ItemChanges::default()
            },
        },
    );
    ctx.finish(job);
    Ok(())
}

fn article(capture: ArticleCapture) -> InboxArticle {
    InboxArticle {
        url: capture.url,
        content_markdown: capture.content_markdown,
        excerpt: capture.excerpt,
        extraction_status: match capture.extraction_status {
            ExtractionStatus::Full => InboxExtractionStatus::Full,
            ExtractionStatus::Partial => InboxExtractionStatus::Partial,
            ExtractionStatus::Failed => InboxExtractionStatus::Failed,
        },
        properties: InboxArticleProperties {
            title: capture.properties.title,
            source: capture.properties.source,
            author: capture.properties.author,
            published: capture.properties.published,
            created: capture.properties.created,
            description: capture.properties.description,
        },
        hero_image: capture.hero_image,
    }
}
