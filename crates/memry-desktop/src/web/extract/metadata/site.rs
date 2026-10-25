//! `getSiteName`, `getBestTitle` and `isSiteIdentifier`.

use super::meta_tags::{MetaAttr, get_meta_content, valid};
use super::schema_property::get_schema_property;
use crate::web::extract::defuddle::schema_org::MetaTag;
use crate::web::extract::dom::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{to_lower, trim};
use crate::web::extract::utils::json::JsValue;
use crate::web::extract::utils::text::count_words;

/// `getSiteName`: the first usable candidate, rejected when it is longer than a site name.
pub fn get_site_name(schema: &JsValue, meta: &[MetaTag]) -> String {
    let candidates: [&dyn Fn() -> String; 9] = [
        &|| get_schema_property(schema, "publisher.name"),
        &|| get_meta_content(meta, MetaAttr::Property, "og:site_name"),
        &|| get_meta_content(meta, MetaAttr::Name, "og:site_name"),
        &|| get_schema_property(schema, "WebSite.name"),
        &|| get_schema_property(schema, "sourceOrganization.name"),
        &|| get_meta_content(meta, MetaAttr::Name, "copyright"),
        &|| get_schema_property(schema, "copyrightHolder.name"),
        &|| get_schema_property(schema, "isPartOf.name"),
        &|| get_meta_content(meta, MetaAttr::Name, "application-name"),
    ];
    let candidate = candidates
        .iter()
        .find_map(|f| valid(f()))
        .unwrap_or_default();
    // Some pages set og:site_name to the full page title.
    if !candidate.is_empty() && count_words(&candidate) > 6 {
        return String::new();
    }
    candidate
}

/// `isSiteIdentifier`: the candidate is the author, the site name or the domain's name.
fn is_site_identifier(
    candidate: &str,
    author_norm: &str,
    site_norm: &str,
    domain_norm: &str,
) -> bool {
    let norm = to_lower(trim(candidate));
    if !author_norm.is_empty() && norm == author_norm {
        return true;
    }
    if !site_norm.is_empty() && norm == site_norm {
        return true;
    }
    !domain_norm.is_empty() && alphanumeric_only(&norm) == domain_norm
}

/// `s.replace(/[^a-z0-9]/g, '')`.
fn alphanumeric_only(s: &str) -> String {
    s.chars()
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9'))
        .collect()
}

/// `getBestTitle`: the first title candidate that is not a brand or domain name.
pub fn get_best_title(
    doc: &Document,
    schema: &JsValue,
    meta: &[MetaTag],
    domain: &str,
    site_name: &str,
) -> Result<String, ExtractError> {
    let text_of = |selector: &str| -> Result<String, ExtractError> {
        Ok(match doc.query_selector(doc.root(), selector)? {
            Some(el) => trim(&doc.text_content(el).unwrap_or_default()).to_string(),
            None => String::new(),
        })
    };
    let candidates: Vec<String> = [
        get_meta_content(meta, MetaAttr::Property, "og:title"),
        get_meta_content(meta, MetaAttr::Name, "twitter:title"),
        get_schema_property(schema, "headline"),
        get_meta_content(meta, MetaAttr::Name, "title"),
        get_meta_content(meta, MetaAttr::Name, "sailthru.title"),
        text_of("title")?,
        text_of("h1")?,
    ]
    .into_iter()
    .filter(|c| valid(c.clone()).is_some())
    .collect();
    let Some(first) = candidates.first() else {
        return Ok(String::new());
    };
    let author_meta = [
        get_meta_content(meta, MetaAttr::Property, "author"),
        get_meta_content(meta, MetaAttr::Name, "author"),
    ]
    .into_iter()
    .find(|v| !v.is_empty())
    .unwrap_or_default();
    let author_norm = to_lower(trim(&author_meta));
    let site_norm = to_lower(trim(site_name));
    let domain_norm = if domain.is_empty() {
        String::new()
    } else {
        // `domain.replace(/\.[^.]+$/, '')`: drop the last label when something follows its dot.
        let without_tld = match domain.rfind('.') {
            Some(dot) if dot + 1 < domain.len() => &domain[..dot],
            _ => domain,
        };
        alphanumeric_only(&to_lower(without_tld))
    };
    Ok(candidates
        .iter()
        .find(|c| !is_site_identifier(c, &author_norm, &site_norm, &domain_norm))
        .unwrap_or(first)
        .clone())
}
