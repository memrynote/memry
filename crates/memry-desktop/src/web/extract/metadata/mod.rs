//! Port of `MetadataExtractor` (`dist/metadata.js`): the title, author, dates, site name, image,
//! language and favicon of a page, from meta tags, JSON-LD and the document itself.

mod author;
mod dates;
mod favicon;
mod meta_tags;
mod schema_property;
mod site;
mod title;

use url::Url;

use super::defuddle::schema_org::MetaTag;
use super::dom::Document;
use super::error::ExtractError;
use super::utils::json::JsValue;
use meta_tags::{MetaAttr, first_nonempty, get_meta_content, valid};

pub use author::clean_author_string;
pub use dates::parse_date_text;
pub use meta_tags::{MetaAttr as MetaAttribute, get_meta_contents, is_placeholder_value};
pub use schema_property::get_schema_property;
pub use title::{CleanedTitle, clean_title};

/// The fields `MetadataExtractor.extract` returns that the pipeline reads (`wordCount` and
/// `parseTime` are filled in by Defuddle, and `schemaOrgData` is the caller's own value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub title: String,
    pub description: String,
    pub domain: String,
    pub favicon: String,
    pub image: String,
    pub language: String,
    pub published: String,
    pub author: String,
    pub site: String,
}

/// `new URL(url).hostname.replace(/^www\./, '')`; `None` when the URL does not parse.
fn domain_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str().unwrap_or_default();
    Some(host.strip_prefix("www.").unwrap_or(host).to_string())
}

/// `MetadataExtractor.extract(doc, schemaOrgData, metaTags)`.
///
/// linkedom documents have no `location`, so the page URL always comes from the metadata
/// fallbacks (`og:url`, schema.org, the canonical link).
pub fn extract(
    doc: &mut Document,
    schema: &JsValue,
    meta: &[MetaTag],
) -> Result<Metadata, ExtractError> {
    let canonical = match doc.query_selector(doc.root(), r#"link[rel="canonical"]"#)? {
        Some(link) => doc
            .get_attribute(link, "href")
            .map(|h| h.into_owned())
            .unwrap_or_default(),
        None => String::new(),
    };
    let url = first_nonempty([
        get_meta_content(meta, MetaAttr::Property, "og:url"),
        get_meta_content(meta, MetaAttr::Property, "twitter:url"),
        get_schema_property(schema, "url"),
        get_schema_property(schema, "mainEntityOfPage.url"),
        get_schema_property(schema, "mainEntity.url"),
        get_schema_property(schema, "WebSite.url"),
        canonical,
    ]);
    let domain = if url.is_empty() {
        String::new()
    } else {
        domain_of(&url).unwrap_or_else(|| {
            tracing::debug!(%url, "metadata URL does not parse");
            String::new()
        })
    };

    let site_name = site::get_site_name(schema, meta);
    let best = site::get_best_title(doc, schema, meta, &domain, &site_name)?;
    let CleanedTitle {
        title,
        detected_site_name,
    } = title::clean_title(&best, &site_name);
    let author = author::get_author(doc, schema, meta)?;
    // A personal-blog author is a usable site name; a multi-author string is not.
    let author_as_site = if !author.is_empty() && !author.contains(',') {
        author.clone()
    } else {
        String::new()
    };
    let site = first_nonempty([
        site_name,
        detected_site_name,
        author_as_site,
        domain.clone(),
    ]);

    Ok(Metadata {
        title,
        description: get_description(schema, meta),
        favicon: favicon::get_favicon(doc, &url, meta)?,
        image: favicon::get_image(schema, meta),
        language: favicon::get_language(doc, schema, meta)?,
        published: dates::get_published(doc, schema, meta, &url)?,
        domain,
        author,
        site,
    })
}

/// `getDescription`.
fn get_description(schema: &JsValue, meta: &[MetaTag]) -> String {
    [
        get_meta_content(meta, MetaAttr::Name, "description"),
        get_meta_content(meta, MetaAttr::Property, "description"),
        get_meta_content(meta, MetaAttr::Property, "og:description"),
        get_schema_property(schema, "description"),
        get_meta_content(meta, MetaAttr::Name, "twitter:description"),
        get_meta_content(meta, MetaAttr::Name, "sailthru.description"),
    ]
    .into_iter()
    .find_map(valid)
    .unwrap_or_default()
}
