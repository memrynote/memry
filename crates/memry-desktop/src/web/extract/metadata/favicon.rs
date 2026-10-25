//! Image, language and favicon lookups of `dist/metadata.js`.

use url::Url;

use super::meta_tags::{MetaAttr, get_meta_content};
use super::schema_property::get_schema_property;
use crate::web::extract::defuddle::schema_org::MetaTag;
use crate::web::extract::dom::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;
use crate::web::extract::utils::json::JsValue;

/// `getImage`.
pub fn get_image(schema: &JsValue, meta: &[MetaTag]) -> String {
    [
        get_meta_content(meta, MetaAttr::Property, "og:image"),
        get_meta_content(meta, MetaAttr::Name, "twitter:image"),
        get_schema_property(schema, "image.url"),
        get_meta_content(meta, MetaAttr::Name, "sailthru.image.full"),
    ]
    .into_iter()
    .find(|v| !v.is_empty())
    .unwrap_or_default()
}

/// `normalizeLangCode`: `en_US` becomes `en-US`.
fn normalize_lang_code(code: &str) -> String {
    code.replace('_', "-")
}

/// `getLanguage`.
pub fn get_language(
    doc: &Document,
    schema: &JsValue,
    meta: &[MetaTag],
) -> Result<String, ExtractError> {
    if let Some(html) = doc.document_element()
        && let Some(lang) = doc.get_attribute(html, "lang")
    {
        let lang = trim(&lang);
        if !lang.is_empty() {
            return Ok(normalize_lang_code(lang));
        }
    }
    let content_lang = [
        get_meta_content(meta, MetaAttr::Name, "content-language"),
        get_meta_content(meta, MetaAttr::Property, "og:locale"),
    ]
    .into_iter()
    .find(|v| !v.is_empty());
    if let Some(lang) = content_lang {
        return Ok(normalize_lang_code(&lang));
    }
    if let Some(meta_el) =
        doc.query_selector(doc.root(), r#"meta[http-equiv="Content-Language" i]"#)?
        && let Some(content) = doc.get_attribute(meta_el, "content")
    {
        let content = trim(&content);
        if !content.is_empty() {
            return Ok(normalize_lang_code(content));
        }
    }
    let schema_lang = get_schema_property(schema, "inLanguage");
    if !schema_lang.is_empty() {
        return Ok(normalize_lang_code(&schema_lang));
    }
    Ok(String::new())
}

/// `getFavicon`.
pub fn get_favicon(
    doc: &Document,
    base_url: &str,
    meta: &[MetaTag],
) -> Result<String, ExtractError> {
    let from_meta = get_meta_content(meta, MetaAttr::Property, "og:image:favicon");
    if !from_meta.is_empty() {
        return Ok(from_meta);
    }
    for selector in ["link[rel='icon']", "link[rel='shortcut icon']"] {
        if let Some(link) = doc.query_selector(doc.root(), selector)?
            && let Some(href) = doc.get_attribute(link, "href")
            && !href.is_empty()
        {
            return Ok(href.into_owned());
        }
    }
    if (base_url.starts_with("http://") || base_url.starts_with("https://"))
        && let Ok(base) = Url::parse(base_url)
        && let Ok(icon) = base.join("/favicon.ico")
    {
        return Ok(icon.to_string());
    }
    Ok(String::new())
}
