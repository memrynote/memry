//! Rendering of an X article's Draft.js blocks (`dist/extractors/x-oembed.js`).

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::trim;
use crate::web::extract::utils::json::JsValue;

use super::x_oembed::{CODE_FENCE, Marker, apply_markers, array, need, number, prop, text_prop};

fn entity_by_key<'a>(entity_map: &'a [JsValue], key: &JsValue) -> Option<&'a JsValue> {
    let wanted = key.to_js_string();
    entity_map
        .iter()
        .find(|e| prop(e, "key").and_then(JsValue::as_str) == Some(wanted.as_str()))
}

fn render_inline(block: &JsValue, entity_map: &[JsValue]) -> Result<String, ExtractError> {
    let text_value = need(prop(block, "text"), "undefined (text)")?;
    let text = text_value.to_js_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    let mut markers = Vec::new();
    let wrap = |markers: &mut Vec<Marker>, start: i64, end: i64, open: String, close: &str| {
        markers.push(Marker {
            offset: start,
            open: true,
            tag: open,
        });
        markers.push(Marker {
            offset: end,
            open: false,
            tag: close.to_string(),
        });
    };
    for range in array(prop(block, "inlineStyleRanges"), "inlineStyleRanges")? {
        if text_prop(range, "style") == "Bold" {
            let (o, l) = (
                number(need(prop(range, "offset"), "range")?),
                number(need(prop(range, "length"), "range")?),
            );
            wrap(&mut markers, o, o + l, "<strong>".into(), "</strong>");
        }
    }
    for range in array(prop(block, "entityRanges"), "entityRanges")? {
        let key = need(prop(range, "key"), "range")?;
        if let Some(entity) = entity_by_key(entity_map, key).and_then(|e| prop(e, "value"))
            && text_prop(entity, "type") == "LINK"
            && let Some(url) = prop(entity, "data")
                .map(|d| text_prop(d, "url"))
                .filter(|u| !u.is_empty())
        {
            let (o, l) = (
                number(need(prop(range, "offset"), "range")?),
                number(need(prop(range, "length"), "range")?),
            );
            wrap(
                &mut markers,
                o,
                o + l,
                format!("<a href=\"{}\">", escape_html(&url)),
                "</a>",
            );
        }
    }
    if let Some(data) = prop(block, "data") {
        if let Some(mentions) = prop(data, "mentions").filter(|m| m.truthy()) {
            for m in array(Some(mentions), "mentions")? {
                let url = format!("https://x.com/{}", escape_html(&text_prop(m, "text")));
                wrap(
                    &mut markers,
                    number(need(prop(m, "fromIndex"), "mention")?),
                    number(need(prop(m, "toIndex"), "mention")?),
                    format!("<a href=\"{url}\">"),
                    "</a>",
                );
            }
        }
        if let Some(urls) = prop(data, "urls").filter(|m| m.truthy()) {
            for u in array(Some(urls), "urls")? {
                let url = escape_html(&text_prop(u, "text"));
                wrap(
                    &mut markers,
                    number(need(prop(u, "fromIndex"), "url")?),
                    number(need(prop(u, "toIndex"), "url")?),
                    format!("<a href=\"{url}\">"),
                    "</a>",
                );
            }
        }
    }
    Ok(apply_markers(&text, markers))
}

fn render_media(entity: &JsValue, media_entities: &[JsValue]) -> Result<String, ExtractError> {
    let data = need(prop(entity, "data"), "undefined (data)")?;
    let items: &[JsValue] = match prop(data, "mediaItems").filter(|m| m.truthy()) {
        Some(list) => array(Some(list), "mediaItems")?,
        None => &[],
    };
    let caption = text_prop(data, "caption");
    let mut images = Vec::new();
    for item in items {
        let id = prop(item, "mediaId").map_or("undefined".to_string(), JsValue::to_js_string);
        let found = media_entities.iter().find(|e| {
            prop(e, "media_id").map_or("undefined".to_string(), JsValue::to_js_string) == id
        });
        let Some(media_entity) = found else { continue };
        let info = need(prop(media_entity, "media_info"), "undefined (media_info)")?;
        let typename = text_prop(info, "__typename");
        let alt = if caption.is_empty() {
            String::new()
        } else {
            escape_html(&caption)
        };
        if typename == "ApiImage" && !text_prop(info, "original_img_url").is_empty() {
            images.push(format!(
                "<img src=\"{}\" alt=\"{alt}\">",
                escape_html(&text_prop(info, "original_img_url"))
            ));
        } else if typename == "ApiVideo"
            && let Some(preview) = prop(info, "preview_image")
                .map(|p| text_prop(p, "original_img_url"))
                .filter(|p| !p.is_empty())
        {
            let mut variants: Vec<&JsValue> = match prop(info, "variants").filter(|v| v.truthy()) {
                Some(list) => array(Some(list), "variants")?
                    .iter()
                    .filter(|v| {
                        text_prop(v, "content_type") == "video/mp4"
                            && prop(v, "bit_rate").is_some_and(JsValue::truthy)
                    })
                    .collect(),
                None => Vec::new(),
            };
            let rate = |v: &JsValue| {
                prop(v, "bit_rate")
                    .filter(|b| b.truthy())
                    .map_or(0.0, JsValue::to_number)
            };
            variants.sort_by(|a, b| {
                rate(b)
                    .partial_cmp(&rate(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let video = variants
                .first()
                .map(|v| text_prop(v, "url"))
                .unwrap_or_default();
            if video.is_empty() {
                images.push(format!(
                    "<img src=\"{}\" alt=\"{alt}\">",
                    escape_html(&preview)
                ));
            } else {
                images.push(format!(
                    "<video src=\"{}\" poster=\"{}\" controls></video>",
                    escape_html(&video),
                    escape_html(&preview)
                ));
            }
        }
    }
    Ok(if !images.is_empty() && !caption.is_empty() {
        format!(
            "<figure>{}<figcaption>{}</figcaption></figure>",
            images.join("\n"),
            escape_html(&caption)
        )
    } else if !images.is_empty() {
        images
            .iter()
            .map(|i| format!("<figure>{i}</figure>"))
            .collect::<Vec<_>>()
            .join("\n")
    } else if !caption.is_empty() {
        format!(
            "<figure><figcaption>{}</figcaption></figure>",
            escape_html(&caption)
        )
    } else {
        String::new()
    })
}

fn render_atomic(
    block: &JsValue,
    entity_map: &[JsValue],
    media_entities: &[JsValue],
) -> Result<String, ExtractError> {
    let ranges = array(prop(block, "entityRanges"), "entityRanges")?;
    let Some(first) = ranges.first() else {
        return Ok(String::new());
    };
    let Some(entry) = entity_by_key(entity_map, need(prop(first, "key"), "range")?) else {
        return Ok(String::new());
    };
    let entity = need(prop(entry, "value"), "undefined (value)")?;
    match text_prop(entity, "type").as_str() {
        "MEDIA" => render_media(entity, media_entities),
        "MARKDOWN" => {
            let markdown = prop(entity, "data")
                .map(|d| text_prop(d, "markdown"))
                .unwrap_or_default();
            Ok(match CODE_FENCE.captures(&markdown) {
                Some(m) => {
                    let attrs = if m[1].is_empty() {
                        String::new()
                    } else {
                        let lang = escape_html(&m[1]);
                        format!(" class=\"language-{lang}\" data-lang=\"{lang}\"")
                    };
                    format!("<pre><code{attrs}>{}</code></pre>", escape_html(&m[2]))
                }
                None => format!("<pre><code>{}</code></pre>", escape_html(&markdown)),
            })
        }
        _ => Ok(String::new()),
    }
}

fn block_type(block: &JsValue) -> String {
    text_prop(block, "type")
}

pub(super) fn render_article(
    blocks: &[JsValue],
    entity_map: &[JsValue],
    cover: Option<&JsValue>,
    media_entities: &[JsValue],
) -> Result<String, ExtractError> {
    let mut parts = Vec::new();
    if let Some(url) = cover
        .and_then(|c| prop(c, "media_info"))
        .map(|i| text_prop(i, "original_img_url"))
        .filter(|u| !u.is_empty())
    {
        parts.push(format!(
            "<img src=\"{}\" alt=\"Cover image\">",
            escape_html(&url)
        ));
    }
    let mut i = 0;
    while i < blocks.len() {
        let block = &blocks[i];
        if block_type(block) == "unordered-list-item" {
            let mut items = Vec::new();
            while i < blocks.len() && block_type(&blocks[i]) == "unordered-list-item" {
                items.push(format!(
                    "<li>{}</li>",
                    render_inline(&blocks[i], entity_map)?
                ));
                i += 1;
            }
            parts.push(format!("<ul>{}</ul>", items.join("")));
            continue;
        }
        let html = match block_type(block).as_str() {
            "header-two" => format!("<h2>{}</h2>", render_inline(block, entity_map)?),
            "header-three" => format!("<h3>{}</h3>", render_inline(block, entity_map)?),
            "atomic" => render_atomic(block, entity_map, media_entities)?,
            _ => {
                let text = need(prop(block, "text"), "undefined (text)")?.to_js_string();
                if trim(&text).is_empty() {
                    String::new()
                } else {
                    format!("<p>{}</p>", render_inline(block, entity_map)?)
                }
            }
        };
        if !html.is_empty() {
            parts.push(html);
        }
        i += 1;
    }
    Ok(format!(
        "<article class=\"x-article\">{}</article>",
        parts.join("\n")
    ))
}
