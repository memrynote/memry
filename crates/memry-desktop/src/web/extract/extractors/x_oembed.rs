//! `dist/extractors/x-oembed.js`: a tweet or article fetched from FxTwitter, or from the
//! oEmbed endpoint when FxTwitter fails. It never extracts from the page itself.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::{FetchRequest, Fetcher};
use crate::web::extract::utils::comments::build_content_html;
use crate::web::extract::utils::date::iso_date_or_empty;
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::{
    WS, encode_uri_component, is_js_whitespace, trim, utf16_len, utf16_slice,
};
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, Extracted, Extractor, Variables, description_cut, post_title};

pub struct XOembedExtractor;

impl XOembedExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}

static STATUS_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(status|article)/[0-9]+").expect("static pattern"));
static HANDLE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/([a-zA-Z0-9_][a-zA-Z0-9_]{0,14})/(status|article)/([0-9]+)").expect("static")
});
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").expect("static"));
static PARAGRAPH_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\n+").expect("static"));
static CODE_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^```([A-Za-z0-9_]*)\n((?s:.)*?)\n?```$").expect("static"));
static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static"));

/// `value.key` where a missing property is `undefined`.
fn prop<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    value.get(key)
}

fn text_prop(value: &JsValue, key: &str) -> String {
    prop(value, key)
        .filter(|v| v.truthy())
        .map(JsValue::to_js_string)
        .unwrap_or_default()
}

/// `value.key` that must exist: reading a property of `undefined` throws in JS.
fn need<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a JsValue, ExtractError> {
    value
        .filter(|v| !matches!(v, JsValue::Null))
        .ok_or_else(|| ExtractError::Js(format!("TypeError: cannot read properties of {what}")))
}

fn array<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], ExtractError> {
    match value {
        Some(JsValue::Array(items)) => Ok(items),
        _ => Err(ExtractError::Js(format!(
            "TypeError: {what} is not iterable"
        ))),
    }
}

fn number(value: &JsValue) -> i64 {
    value.to_number() as i64
}

fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

struct Facet {
    kind: String,
    start: i64,
    end: i64,
    text: String,
    original: String,
}

struct Marker {
    offset: i64,
    open: bool,
    tag: String,
}

fn code_point_to_utf16(text: &str, code_point_index: i64) -> i64 {
    let mut units = 0;
    for (count, c) in text.chars().enumerate() {
        if count as i64 >= code_point_index {
            break;
        }
        units += c.len_utf16() as i64;
    }
    units
}

fn apply_markers(text: &str, mut markers: Vec<Marker>) -> String {
    if markers.is_empty() {
        return escape_html(text);
    }
    markers.sort_by(|a, b| {
        a.offset
            .cmp(&b.offset)
            .then_with(|| match (a.open, b.open) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
    });
    let length = utf16_len(text) as i64;
    let (mut result, mut pos) = (String::new(), 0i64);
    for marker in &markers {
        if marker.offset > pos {
            result.push_str(&escape_html(&utf16_slice(
                text,
                pos.max(0) as usize,
                marker.offset.max(0) as usize,
            )));
        }
        result.push_str(&marker.tag);
        pos = marker.offset;
    }
    if pos < length {
        result.push_str(&escape_html(&utf16_slice(
            text,
            pos.max(0) as usize,
            length as usize,
        )));
    }
    result
}

fn apply_facets(text: &str, text_start: i64, text_end: i64, facets: &[Facet]) -> String {
    let length = utf16_len(text) as i64;
    let mut markers = Vec::new();
    for f in facets {
        if f.end <= text_start || f.start >= text_end {
            continue;
        }
        let rel_start = (f.start - text_start).max(0);
        let rel_end = length.min(f.end - text_start);
        let mut wrap = |open: String, close: &str| {
            markers.push(Marker {
                offset: rel_start,
                open: true,
                tag: open,
            });
            markers.push(Marker {
                offset: rel_end,
                open: false,
                tag: close.to_string(),
            });
        };
        if f.kind == "italic" {
            wrap("<em>".into(), "</em>");
        } else if f.kind == "mention" && !f.text.is_empty() {
            wrap(
                format!("<a href=\"https://x.com/{}\">", escape_html(&f.text)),
                "</a>",
            );
        } else if f.kind == "url" && !f.original.is_empty() {
            wrap(format!("<a href=\"{}\">", escape_html(&f.original)), "</a>");
        }
    }
    apply_markers(text, markers)
}

fn index_from(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(hay.len()));
    }
    (from..=hay.len().checked_sub(needle.len())?).find(|&i| hay[i..i + needle.len()] == *needle)
}

fn render_tweet(tweet: &JsValue) -> Result<String, ExtractError> {
    let raw_text = prop(tweet, "raw_text");
    let text = {
        let own = raw_text.map(|r| text_prop(r, "text")).unwrap_or_default();
        if own.is_empty() {
            text_prop(tweet, "text")
        } else {
            own
        }
    };
    let mut facets = Vec::new();
    if let Some(list) = raw_text
        .and_then(|r| prop(r, "facets"))
        .filter(|f| f.truthy())
    {
        for f in array(Some(list), "facets")? {
            let kind = text_prop(f, "type");
            if kind == "media" {
                continue;
            }
            let indices = array(prop(f, "indices"), "facet.indices")?;
            let at = |i: usize| indices.get(i).map(number).unwrap_or(0);
            facets.push(Facet {
                kind,
                start: at(0),
                end: at(1),
                text: text_prop(f, "text"),
                original: text_prop(f, "original"),
            });
        }
    }
    if text.chars().any(|c| c.len_utf16() == 2) {
        for f in &mut facets {
            f.start = code_point_to_utf16(&text, f.start);
            f.end = code_point_to_utf16(&text, f.end);
        }
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut offset = 0usize;
    let mut parts = Vec::new();
    for para in PARAGRAPH_BREAK.split(&text) {
        let para_units: Vec<u16> = para.encode_utf16().collect();
        let para_start = index_from(&units, &para_units, offset).map_or(-1, |i| i as i64);
        let para_end = para_start + para_units.len() as i64;
        offset = para_end.max(0) as usize;
        let ts = trim_start(para);
        let is_block = ts.starts_with('>');
        let (para_text, text_start) = if is_block {
            let rest = &ts[1..];
            let rest_trim = trim_start(rest);
            let start = para_start
                + (utf16_len(para) - utf16_len(ts)) as i64
                + 1
                + (utf16_len(rest) - utf16_len(rest_trim)) as i64;
            (rest_trim.to_string(), start)
        } else {
            (para.to_string(), para_start)
        };
        let rendered =
            apply_facets(&para_text, text_start, para_end, &facets).replace('\n', "<br>");
        if is_block {
            parts.push(format!("<blockquote><p>{rendered}</p></blockquote>"));
        } else if !trim(&rendered).is_empty() {
            parts.push(format!("<p>{rendered}</p>"));
        }
    }
    if let Some(photos) = prop(tweet, "media")
        .and_then(|m| prop(m, "photos"))
        .filter(|p| p.truthy())
    {
        for photo in array(Some(photos), "photos")? {
            parts.push(format!(
                "<img src=\"{}\" alt=\"\">",
                escape_html(&text_prop(photo, "url"))
            ));
        }
    }
    Ok(parts.join("\n"))
}

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

fn render_article(
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

fn first_date(a: &JsValue, b: &JsValue, key: &str) -> String {
    let pick = |v: &JsValue| {
        prop(v, key)
            .filter(|d| d.truthy())
            .map(|d| iso_date_or_empty(&d.to_js_string()))
            .unwrap_or_default()
    };
    let first = pick(a);
    if first.is_empty() { pick(b) } else { first }
}

fn build_article(data: &JsValue) -> Result<Extracted, ExtractError> {
    let tweet = need(prop(data, "tweet"), "undefined (tweet)")?;
    let article = need(prop(tweet, "article"), "undefined (article)")?;
    let content = need(prop(article, "content"), "undefined (content)")?;
    let blocks = array(prop(content, "blocks"), "blocks")?;
    let entity_map = array(prop(content, "entityMap"), "entityMap")?;
    let media_entities: &[JsValue] = match prop(article, "media_entities").filter(|m| m.truthy()) {
        Some(list) => array(Some(list), "media_entities")?,
        None => &[],
    };
    let content_html = render_article(
        blocks,
        entity_map,
        prop(article, "cover_media"),
        media_entities,
    )?;
    let handle = format!(
        "@{}",
        text_prop(
            need(prop(tweet, "author"), "undefined (author)")?,
            "screen_name"
        )
    );
    let published = first_date(article, tweet, "created_at");
    Ok(Extracted {
        content_html,
        content_selector: None,
        variables: Variables {
            title: text_prop(article, "title"),
            author: handle,
            site: "X (Twitter)".into(),
            description: text_prop(article, "preview_text"),
            published,
            ..Variables::default()
        },
    })
}

fn build_tweet(data: &JsValue) -> Result<Extracted, ExtractError> {
    let tweet = need(prop(data, "tweet"), "undefined (tweet)")?;
    let handle = format!(
        "@{}",
        text_prop(
            need(prop(tweet, "author"), "undefined (author)")?,
            "screen_name"
        )
    );
    let post = render_tweet(tweet)?;
    Ok(Extracted {
        content_html: build_content_html("twitter", &post, ""),
        content_selector: None,
        variables: Variables {
            title: post_title(&handle, "X"),
            author: handle,
            site: "X (Twitter)".into(),
            description: description_cut(trim(&text_prop(tweet, "text"))),
            published: prop(tweet, "created_at")
                .filter(|d| d.truthy())
                .map(|d| iso_date_or_empty(&d.to_js_string()))
                .unwrap_or_default(),
            ..Variables::default()
        },
    })
}

fn get(
    fetcher: &dyn Fetcher,
    url: String,
    headers: Vec<(String, String)>,
) -> Result<JsValue, String> {
    let response = fetcher.fetch(FetchRequest {
        url,
        method: "GET".into(),
        headers,
        body: None,
    })?;
    if !response.ok {
        return Err(format!("request failed: {}", response.status));
    }
    parse(&response.text)
}

fn try_fx_twitter(cx: &Cx, fetcher: &dyn Fetcher) -> Option<Extracted> {
    let m = HANDLE_URL.captures(cx.url)?;
    let api = format!("https://api.fxtwitter.com/{}/status/{}", &m[1], &m[3]);
    let headers = vec![(
        "User-Agent".to_string(),
        "Mozilla/5.0 (compatible; Defuddle/1.0; +https://defuddle.md)".to_string(),
    )];
    let data = get(fetcher, api, headers).ok()?;
    let tweet = prop(&data, "tweet").filter(|t| !matches!(t, JsValue::Null))?;
    if prop(tweet, "article").is_some_and(JsValue::truthy) {
        return build_article(&data).ok();
    }
    if prop(tweet, "text").is_some_and(JsValue::truthy) {
        return build_tweet(&data).ok();
    }
    None
}

fn extract_oembed(cx: &mut Cx, fetcher: &dyn Fetcher) -> Result<Extracted, ExtractError> {
    let url = format!(
        "https://publish.twitter.com/oembed?url={}&omit_script=true",
        encode_uri_component(cx.url)
    );
    let data = get(fetcher, url, Vec::new()).map_err(ExtractError::Js)?;
    let html = text_prop(&data, "html");
    let div = cx.doc.create_element("div");
    let fragment = cx.doc.parse_fragment(&html);
    cx.doc.append_child(div, fragment)?;
    let paragraphs = match cx.doc.query_selector(div, "blockquote")? {
        Some(q) => cx.doc.query_selector_all(q, "p")?,
        None => Vec::new(),
    };
    let tweet_text = paragraphs
        .iter()
        .map(|&p| format!("<p>{}</p>", cx.doc.inner_html(p)))
        .collect::<Vec<_>>()
        .join("\n");
    let author_url = text_prop(&data, "author_url");
    let handle = if author_url.is_empty() {
        String::new()
    } else {
        format!("@{}", author_url.rsplit('/').next().unwrap_or_default())
    };
    let author = if handle.is_empty() {
        text_prop(&data, "author_name")
    } else {
        handle
    };
    let plain = TAGS.replace_all(&tweet_text, "");
    Ok(Extracted {
        content_html: build_content_html("twitter", &tweet_text, ""),
        content_selector: None,
        variables: Variables {
            title: post_title(&author, "X"),
            description: RUNS
                .replace_all(&utf16_slice(trim(&plain), 0, 140), " ")
                .into_owned(),
            author,
            site: "X (Twitter)".into(),
            ..Variables::default()
        },
    })
}

impl Extractor for XOembedExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(false)
    }

    fn extract(&mut self, _cx: &mut Cx) -> Result<Extracted, ExtractError> {
        Ok(Extracted::default())
    }

    fn can_extract_async(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(STATUS_URL.is_match(cx.url))
    }

    fn prefers_async(&self) -> bool {
        true
    }

    fn extract_async(
        &mut self,
        cx: &mut Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        if let Some(result) = try_fx_twitter(cx, fetcher) {
            return Ok(result);
        }
        extract_oembed(cx, fetcher)
    }
}
