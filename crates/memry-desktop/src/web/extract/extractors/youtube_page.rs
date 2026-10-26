//! `YoutubeExtractor.getVideoData` and `getChannelName`: the video's page metadata.

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, sel_attr, text_of, trimmed};
use super::youtube::player_response;
use super::youtube_data::string_at;

/// `getVideoData()`: the JSON-LD `VideoObject`, else the Open Graph tags, else nothing.
pub(super) fn video_data(cx: &Cx, video_id: &str) -> Result<JsValue, ExtractError> {
    let mut fallback: Option<JsValue> = None;
    for script in cx.qsa(r#"script[type="application/ld+json"]"#)? {
        let Ok(data) = parse(&text_of(cx.doc, script)) else {
            continue;
        };
        let items: Vec<&JsValue> = match &data {
            JsValue::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        let mut found = None;
        for item in items {
            // `item['@type']` on null throws, which the script's catch swallows.
            if matches!(item, JsValue::Null) {
                found = None;
                break;
            }
            if item.get("@type").and_then(JsValue::as_str) != Some("VideoObject") {
                continue;
            }
            let id = ["@id", "url", "embedUrl"]
                .iter()
                .find_map(|k| item.get(k).filter(|v| v.truthy()))
                .map(JsValue::to_js_string)
                .unwrap_or_default();
            if video_id.is_empty() || id.contains(video_id) {
                found = Some(item.clone());
                break;
            }
        }
        let Some(object) = found else { continue };
        if object.get("description").is_some_and(JsValue::truthy) {
            return Ok(object);
        }
        if object.get("comment").is_some_and(JsValue::truthy) || fallback.is_none() {
            fallback = Some(object);
        }
    }
    if let Some(object) = fallback {
        return Ok(object);
    }
    if !video_id.is_empty() {
        let og_url = sel_attr(cx.doc, cx.root, r#"meta[property="og:url"]"#, "content")?;
        if og_url.contains(video_id) {
            let og = |p: &str| {
                sel_attr(
                    cx.doc,
                    cx.root,
                    &format!(r#"meta[property="{p}"]"#),
                    "content",
                )
            };
            return Ok(JsValue::Object(vec![
                ("name".into(), JsValue::String(og("og:title")?)),
                ("description".into(), JsValue::String(og("og:description")?)),
                ("thumbnailUrl".into(), JsValue::String(og("og:image")?)),
            ]));
        }
    }
    Ok(JsValue::Object(Vec::new()))
}

pub(super) fn channel_name(
    cx: &Cx,
    video_id: &str,
    data: &JsValue,
) -> Result<String, ExtractError> {
    for selector in [
        r#"ytd-video-owner-renderer #channel-name a[href^="/@"]"#,
        r#"#owner-name a[href^="/@"]"#,
    ] {
        if let Some(el) = cx.qs(selector)? {
            let value = trimmed(cx.doc, el);
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    if let Some(root) = cx.qs(r#"[itemprop="author"]"#)? {
        for selector in [r#"meta[itemprop="name"]"#, r#"link[itemprop="name"]"#] {
            let content = sel_attr(cx.doc, root, selector, "content")?;
            if !content.is_empty() {
                return Ok(trim(&content).to_string());
            }
        }
        let text = match cx
            .doc
            .query_selector(root, r#"[itemprop="name"], a, span"#)?
        {
            Some(el) => trimmed(cx.doc, el),
            None => String::new(),
        };
        if !text.is_empty() {
            return Ok(text);
        }
    }
    if let Some(player) = player_response(cx, video_id)? {
        for keys in [
            &["videoDetails", "author"][..],
            &["videoDetails", "ownerChannelName"],
            &[
                "microformat",
                "playerMicroformatRenderer",
                "ownerChannelName",
            ],
        ] {
            let value = string_at(&player, keys);
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    Ok(string_at(data, &["author"]))
}
