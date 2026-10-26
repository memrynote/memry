//! `dist/extractors/bilibili.js`: a video embed, its description and, when the API has
//! subtitles, a transcript.
//!
//! `BilibiliExtractor.transcriptCache` is a process-wide map in JS; it only saves a refetch for
//! a video seen twice, so it is not ported. Tracks that tie on every sort key but the language
//! label and URL compare by code point where JS uses `localeCompare`.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::{FetchRequest, Fetcher};
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::dom::{document_title, escape_html};
use crate::web::extract::utils::js::{WS, encode_uri_component, parse_int, to_lower, trim};
use crate::web::extract::utils::json::{JsValue, parse};
use crate::web::extract::utils::transcript::{Segment, build_transcript};

use super::base::{Cx, Extracted, Extractor, Variables};

const GROUP_GAP: f64 = 20.0;
const MAX_GROUP: f64 = 30.0;

pub struct BilibiliExtractor {
    bvid: String,
    url: String,
}

static BVID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/video/(BV[0-9A-Za-z]+)/?").expect("static pattern"));
static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static"));

impl BilibiliExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let bvid = Url::parse(cx.url)
            .ok()
            .and_then(|u| BVID.captures(u.path()).map(|m| m[1].to_string()))
            .unwrap_or_default();
        Ok(Self {
            bvid,
            url: cx.url.to_string(),
        })
    }

    fn page_number(&self) -> i64 {
        let Ok(url) = Url::parse(&self.url) else {
            return 1;
        };
        let p = url
            .query_pairs()
            .find(|(k, _)| k == "p")
            .map(|(_, v)| v.into_owned());
        let p = p.filter(|p| !p.is_empty()).unwrap_or_else(|| "1".into());
        parse_int(&p).filter(|p| *p > 0).unwrap_or(1)
    }
}

struct Track {
    lan: String,
    lan_doc: Option<String>,
    subtitle_url: String,
    id: Option<f64>,
    is_ai: Option<bool>,
}

struct Transcript {
    html: String,
    language: String,
}

fn truthy_or(value: &JsValue, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = value.get(key)
            && !matches!(v, JsValue::Null)
        {
            return v.to_js_string();
        }
    }
    String::new()
}

fn normalize_lang(code: &str) -> String {
    to_lower(&trim(code).replace('_', "-"))
}

fn lang_priority(code: &str) -> u8 {
    if code == "zh-cn" || code == "zh-hans" {
        0
    } else if code == "zh" {
        1
    } else if code.starts_with("zh-") {
        2
    } else if code == "en" || code.starts_with("en-") {
        3
    } else {
        4
    }
}

fn stable_url_key(u: &str) -> String {
    let input = trim(u);
    if input.is_empty() {
        return String::new();
    }
    let normalized = if input.starts_with("//") {
        format!("https:{input}")
    } else {
        input.to_string()
    };
    match Url::parse(&normalized) {
        Ok(p) => format!("{}{}", to_lower(p.host_str().unwrap_or_default()), p.path()),
        Err(_) => input
            .split('?')
            .next()
            .unwrap_or_default()
            .split('#')
            .next()
            .unwrap_or_default()
            .to_string(),
    }
}

fn pick_track(tracks: Vec<Track>) -> Option<Track> {
    let mut ranked: Vec<(usize, u8, u8, f64, String, String, Track)> = tracks
        .into_iter()
        .enumerate()
        .map(|(index, t)| {
            let code = normalize_lang(&t.lan);
            let doc = to_lower(trim(t.lan_doc.as_deref().unwrap_or_default()));
            let ai_doc = doc.contains("ai") || doc.contains("auto") || doc.contains("自动");
            let ai = u8::from(t.is_ai == Some(true) || ai_doc);
            let id = t.id.unwrap_or(9_007_199_254_740_991.0);
            (
                index,
                ai,
                lang_priority(&code),
                id,
                doc,
                stable_url_key(&t.subtitle_url),
                t,
            )
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then(a.2.cmp(&b.2))
            .then(a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.4.cmp(&b.4))
            .then_with(|| a.5.cmp(&b.5))
            .then(a.0.cmp(&b.0))
    });
    ranked.into_iter().next().map(|r| r.6)
}

fn parse_tracks(json: &JsValue) -> Vec<Track> {
    let subtitle = json.get("data").and_then(|d| d.get("subtitle"));
    for key in ["subtitles", "list", "tracks"] {
        let Some(JsValue::Array(items)) = subtitle.and_then(|s| s.get(key)) else {
            continue;
        };
        return items
            .iter()
            .map(|t| Track {
                lan: truthy_or(t, &["lan", "lang", "language"]),
                lan_doc: t
                    .get("lan_doc")
                    .filter(|d| d.truthy())
                    .map(JsValue::to_js_string),
                subtitle_url: truthy_or(t, &["subtitle_url", "subtitleUrl", "url"]),
                id: match (t.get("id"), t.get("subtitle_id")) {
                    (Some(JsValue::Number(n)), _) => Some(*n),
                    (_, Some(JsValue::Number(n))) => Some(*n),
                    _ => None,
                },
                is_ai: match (t.get("is_ai_subtitle"), t.get("ai_type")) {
                    (Some(JsValue::Bool(b)), _) => Some(*b),
                    (_, Some(JsValue::Number(n))) => Some(*n > 0.0),
                    _ => None,
                },
            })
            .filter(|t| !t.lan.is_empty() && !t.subtitle_url.is_empty())
            .collect();
    }
    Vec::new()
}

fn json_headers() -> Vec<(String, String)> {
    vec![
        ("Accept".into(), "application/json".into()),
        (
            "User-Agent".into(),
            "Mozilla/5.0 (compatible; Defuddle/1.0)".into(),
        ),
    ]
}

fn get(
    fetcher: &dyn Fetcher,
    url: String,
) -> Result<crate::web::extract::fetch::FetchResponse, String> {
    fetcher.fetch(FetchRequest {
        url,
        method: "GET".into(),
        headers: json_headers(),
        body: None,
    })
}

fn fetch_view(fetcher: &dyn Fetcher, bvid: &str) -> Option<JsValue> {
    let url = format!(
        "https://api.bilibili.com/x/web-interface/view?bvid={}",
        encode_uri_component(bvid)
    );
    let response = get(fetcher, url).ok().filter(|r| r.ok)?;
    let json = parse(&response.text).ok()?;
    if !matches!(json.get("code"), Some(JsValue::Number(n)) if *n == 0.0) {
        return None;
    }
    json.get("data").filter(|d| d.truthy()).cloned()
}

fn fetch_player(fetcher: &dyn Fetcher, url: String) -> Result<Vec<Track>, String> {
    let response = get(fetcher, url)?;
    if !response.ok {
        return Ok(Vec::new());
    }
    let json = parse(&response.text)?;
    if !matches!(json.get("code"), Some(JsValue::Number(n)) if *n == 0.0) {
        return Ok(Vec::new());
    }
    Ok(parse_tracks(&json))
}

fn concat_text(prev: &str, next: &str) -> String {
    let a = prev.trim_end_matches(crate::web::extract::utils::js::is_js_whitespace);
    let b = next.trim_start_matches(crate::web::extract::utils::js::is_js_whitespace);
    if a.is_empty() {
        return b.to_string();
    }
    if b.is_empty() {
        return a.to_string();
    }
    let han = |c: Option<char>| c.is_some_and(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c));
    if han(a.chars().next_back()) && han(b.chars().next()) {
        format!("{a}{b}")
    } else {
        format!("{a} {b}")
    }
}

struct Line {
    start: f64,
    end: f64,
    text: String,
}

fn group_lines(lines: &[Line]) -> Vec<Segment> {
    let mut groups: Vec<Segment> = Vec::new();
    let (mut start, mut end, mut text) = (lines[0].start, lines[0].end, lines[0].text.clone());
    fn flush(groups: &mut Vec<Segment>, start: f64, text: &str) {
        let normalized = trim(&RUNS.replace_all(text, " ")).to_string();
        if normalized.is_empty() {
            return;
        }
        groups.push(Segment {
            start: start.floor().max(0.0),
            text: normalized,
            speaker: None,
            speaker_change: !groups.is_empty(),
        });
    }
    for line in &lines[1..] {
        let gap = line.start - end;
        let span = line.end.max(line.start) - start;
        if gap > GROUP_GAP || span > MAX_GROUP {
            flush(&mut groups, start, &text);
            (start, end, text) = (line.start, line.end, line.text.clone());
            continue;
        }
        text = concat_text(&text, &line.text);
        end = end.max(line.end);
    }
    flush(&mut groups, start, &text);
    groups
}

fn parse_subtitle_json(json: &JsValue) -> Option<String> {
    let JsValue::Array(body) = json.get("body")? else {
        return None;
    };
    let mut lines: Vec<Line> = body
        .iter()
        .map(|l| {
            let num = |k: &str| match l.get(k) {
                Some(JsValue::Number(n)) => Some(*n),
                _ => None,
            };
            let start = num("from").unwrap_or(f64::NAN);
            let end = num("to").unwrap_or(start);
            let text = l
                .get("content")
                .filter(|c| c.truthy())
                .map(|c| trim(&c.to_js_string()).to_string())
                .unwrap_or_default();
            Line { start, end, text }
        })
        .filter(|l| l.start.is_finite() && !l.text.is_empty())
        .collect();
    lines.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if lines.is_empty() {
        return None;
    }
    Some(build_transcript("bilibili", &group_lines(&lines), &[]).0)
}

fn fetch_transcript(fetcher: &dyn Fetcher, aid: &str, cid: &str, bvid: &str) -> Option<Transcript> {
    let (e_bvid, e_aid, e_cid) = (
        encode_uri_component(bvid),
        encode_uri_component(aid),
        encode_uri_component(cid),
    );
    let urls = [
        format!("https://api.bilibili.com/x/player/wbi/v2?bvid={e_bvid}&aid={e_aid}&cid={e_cid}"),
        format!("https://api.bilibili.com/x/player/v2?bvid={e_bvid}&cid={e_cid}"),
        format!("https://api.bilibili.com/x/player/v2?aid={e_aid}&cid={e_cid}"),
    ];
    let mut tracks = Vec::new();
    for url in urls {
        tracks = fetch_player(fetcher, url).ok()?;
        if !tracks.is_empty() {
            break;
        }
    }
    let picked = pick_track(tracks)?;
    let trimmed = trim(&picked.subtitle_url);
    if trimmed.is_empty() {
        return None;
    }
    let normalized = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    };
    let url = Url::parse(&normalized)
        .ok()
        .filter(|u| u.scheme() == "https")?;
    let host = to_lower(url.host_str().unwrap_or_default());
    if !(host.ends_with(".hdslb.com") || host.ends_with(".bilibili.com")) {
        return None;
    }
    let response = get(fetcher, url.to_string()).ok().filter(|r| r.ok)?;
    let html = parse_subtitle_json(&parse(&response.text).ok()?)?;
    Some(Transcript {
        html,
        language: picked.lan,
    })
}

impl BilibiliExtractor {
    fn build_result(
        &self,
        cx: &mut Cx,
        transcript: Option<Transcript>,
        view: Option<&JsValue>,
        page_number: Option<i64>,
    ) -> Result<Extracted, ExtractError> {
        let field = |key: &str| view.and_then(|v| v.get(key)).filter(|v| v.truthy());
        let title = match field("title") {
            Some(t) => t.to_js_string(),
            None => document_title(cx.doc, cx.root),
        };
        let author = view
            .and_then(|v| v.get("owner"))
            .and_then(|o| o.get("name"))
            .filter(|n| n.truthy())
            .map(JsValue::to_js_string)
            .unwrap_or_default();
        let desc = field("desc").map(JsValue::to_js_string).unwrap_or_default();
        let description =
            trim(&crate::web::extract::utils::js::utf16_slice(&desc, 0, 200)).to_string();
        let published = match field("pubdate") {
            Some(p) => iso_string(Some(p.to_number() * 1000.0))?,
            None => String::new(),
        };
        let mut content = String::new();
        if !self.bvid.is_empty() {
            let page = page_number
                .filter(|p| *p != 0)
                .unwrap_or_else(|| self.page_number());
            content.push_str(&format!(
                "<iframe width=\"560\" height=\"315\" src=\"https://player.bilibili.com/player.html?bvid={}&page={page}&high_quality=1&danmaku=0\" title=\"Bilibili video player\" frameborder=\"0\" allowfullscreen></iframe>",
                encode_uri_component(&self.bvid)
            ));
        }
        if !desc.is_empty() {
            let safe = escape_html(&desc).replace('\n', "<br>");
            content.push_str(&format!("<p>{safe}</p>"));
        }
        let language = transcript
            .as_ref()
            .map(|t| t.language.clone())
            .unwrap_or_default();
        if let Some(t) = transcript.filter(|t| !t.html.is_empty()) {
            content.push_str(&t.html);
        }
        Ok(Extracted {
            content_html: content,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site: "Bilibili".into(),
                published,
                description,
                language,
            },
        })
    }
}

impl Extractor for BilibiliExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.bvid.is_empty())
    }

    fn can_extract_async(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.bvid.is_empty())
    }

    fn prefers_async(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        self.build_result(cx, None, None, None)
    }

    fn extract_async(
        &mut self,
        cx: &mut Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        if self.bvid.is_empty() {
            return self.build_result(cx, None, None, None);
        }
        let Some(view) = fetch_view(fetcher, &self.bvid) else {
            return self.build_result(cx, None, None, None);
        };
        let pages: &[JsValue] = match view.get("pages") {
            Some(JsValue::Array(p)) => p,
            _ => &[],
        };
        let page_number = self.page_number();
        let page_info = if pages.is_empty() {
            None
        } else {
            let at = usize::try_from(page_number - 1)
                .ok()
                .and_then(|i| pages.get(i))
                .filter(|p| !matches!(p, JsValue::Null));
            Some(at.unwrap_or(&pages[0]))
        };
        let cid = page_info.and_then(|p| p.get("cid")).filter(|c| c.truthy());
        let aid = view.get("aid").filter(|a| a.truthy());
        let transcript = match (aid, cid) {
            (Some(aid), Some(cid)) => fetch_transcript(
                fetcher,
                &aid.to_js_string(),
                &cid.to_js_string(),
                &self.bvid,
            ),
            _ => None,
        };
        self.build_result(cx, transcript, Some(&view), Some(page_number))
    }
}
