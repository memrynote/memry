//! `dist/extractors/youtube.js`: the embed, the description and a transcript, taken from the
//! page's transcript panel, from the caption tracks in the page's inline player response, or
//! from InnerTube.
//!
//! Fetches happen in the order JS issues them: chapters, the inline caption track, the player
//! data (iOS, Android, web), then the caption track the API picked. Opening the transcript
//! panel needs `MutationObserver`, which the Node DOM does not have, so that fallback yields
//! nothing.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::{FetchRequest, Fetcher};
use crate::web::extract::utils::js::{WS, to_lower, trim, utf16_slice};
use crate::web::extract::utils::json::{JsValue, parse};
use crate::web::extract::utils::transcript::{Chapter, Segment, build_transcript};

use super::base::{Cx, Extracted, Extractor, Variables, text_of, trimmed};
use super::youtube_data::{
    Transcript, chapters_from, parse_timestamp, parse_transcript_xml, path, string_at,
};
use super::youtube_group::{Raw, group_transcript_segments};
use super::youtube_page::{channel_name, video_data};

const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const NEXT_URL: &str = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";
const ANDROID_USER_AGENT: &str = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const IOS_CONTEXT: &str = r#"{"clientName":"IOS","clientVersion":"20.10.3"}"#;
const ANDROID_CONTEXT: &str = r#"{"clientName":"ANDROID","clientVersion":"20.10.38"}"#;
const WEB_CONTEXT: &str = r#"{"clientName":"WEB","clientVersion":"2.20240101.00.00"}"#;
const TRANSCRIPT_PANEL: &str = r#"ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]"#;

pub struct YoutubeExtractor {
    url: String,
}

static PAREN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"{WS}*\([^)]*\){WS}*")).expect("static"));
static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static"));

impl YoutubeExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            url: cx.url.to_string(),
        })
    }

    /// `getVideoId()`.
    fn video_id(&self) -> Result<String, ExtractError> {
        let url =
            Url::parse(&self.url).map_err(|e| ExtractError::Js(format!("Invalid URL: {e}")))?;
        let path = url.path();
        Ok(if url.host_str() == Some("youtu.be") {
            path.get(1..).unwrap_or_default().to_string()
        } else if path.contains("/shorts/") {
            path.split("/shorts/")
                .nth(1)
                .unwrap_or_default()
                .split('/')
                .next()
                .unwrap_or_default()
                .to_string()
        } else {
            url.query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        })
    }
}

/// `parseInlineJson(globalName)`: the first balanced `{...}` after the name that parses.
fn parse_inline_json(cx: &Cx, global: &str) -> Result<Option<JsValue>, ExtractError> {
    for script in cx.qsa("script")? {
        let text = text_of(cx.doc, script);
        let Some(at) = text.find(global) else {
            continue;
        };
        let Some(open) = text[at..].find('{').map(|i| i + at) else {
            continue;
        };
        let mut depth = 0i64;
        for (i, c) in text[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        match parse(&text[open..open + i + 1]) {
                            Ok(v) => return Ok(Some(v)),
                            Err(_) => break,
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(None)
}

/// `getValidatedPlayerResponse()`.
pub(super) fn player_response(cx: &Cx, video_id: &str) -> Result<Option<JsValue>, ExtractError> {
    if video_id.is_empty() {
        return Ok(None);
    }
    let Some(data) = parse_inline_json(cx, "ytInitialPlayerResponse")? else {
        return Ok(None);
    };
    let detail = string_at(&data, &["videoDetails", "videoId"]);
    let micro = string_at(
        &data,
        &[
            "microformat",
            "playerMicroformatRenderer",
            "externalVideoId",
        ],
    );
    Ok((detail == video_id || micro == video_id).then_some(data))
}

fn caption_tracks(data: Option<&JsValue>) -> Vec<JsValue> {
    match data.and_then(|d| {
        path(
            d,
            &[
                "captions",
                "playerCaptionsTracklistRenderer",
                "captionTracks",
            ],
        )
    }) {
        Some(JsValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn pick_caption_track(tracks: &[JsValue]) -> Option<&JsValue> {
    let kind_ok = |t: &&JsValue| t.get("kind").and_then(JsValue::as_str) != Some("asr");
    let non_asr: Vec<&JsValue> = tracks.iter().filter(kind_ok).collect();
    let pool: Vec<&JsValue> = if non_asr.is_empty() {
        tracks.iter().collect()
    } else {
        non_asr
    };
    pool.iter()
        .find(|t| t.get("languageCode").and_then(JsValue::as_str) == Some("en"))
        .or_else(|| pool.first())
        .copied()
}

/// `getInlineChapters()`.
fn inline_chapters(cx: &Cx, video_id: &str) -> Result<Vec<Chapter>, ExtractError> {
    let Some(data) = parse_inline_json(cx, "ytInitialData")? else {
        return Ok(Vec::new());
    };
    if !video_id.is_empty()
        && string_at(&data, &["currentVideoEndpoint", "watchEndpoint", "videoId"]) != video_id
        && string_at(&data, &["endpoint", "watchEndpoint", "videoId"]) != video_id
    {
        return Ok(Vec::new());
    }
    Ok(chapters_from(&data))
}

fn request(
    url: &str,
    post: Option<(Vec<(String, String)>, String)>,
    headers: Vec<(String, String)>,
) -> FetchRequest {
    match post {
        Some((h, body)) => FetchRequest {
            url: url.into(),
            method: "POST".into(),
            headers: h,
            body: Some(body.into_bytes()),
        },
        None => FetchRequest {
            url: url.into(),
            method: "GET".into(),
            headers,
            body: None,
        },
    }
}

fn json_headers(user_agent: Option<&str>) -> Vec<(String, String)> {
    let mut h = vec![("Content-Type".to_string(), "application/json".to_string())];
    if let Some(ua) = user_agent {
        h.push(("User-Agent".into(), ua.into()));
    }
    h
}

fn innertube_body(context: &str, video_id: &str) -> String {
    format!(
        "{{\"context\":{{\"client\":{context}}},\"videoId\":{}}}",
        JsValue::String(video_id.into()).stringify()
    )
}

/// `fetchChapters(videoId)`.
fn fetch_chapters(
    cx: &Cx,
    fetcher: &dyn Fetcher,
    video_id: &str,
) -> Result<Vec<Chapter>, ExtractError> {
    let inline = inline_chapters(cx, video_id)?;
    if !inline.is_empty() {
        return Ok(inline);
    }
    let body = innertube_body(WEB_CONTEXT, video_id);
    let fetched = fetcher
        .fetch(request(
            NEXT_URL,
            Some((json_headers(None), body)),
            Vec::new(),
        ))
        .ok()
        .filter(|r| r.ok)
        .and_then(|r| parse(&r.text).ok());
    Ok(fetched.map(|d| chapters_from(&d)).unwrap_or_default())
}

/// `fetchCaptionXml(track, chapters)`.
fn fetch_caption_xml(
    fetcher: &dyn Fetcher,
    track: &JsValue,
    chapters: &[Chapter],
) -> Option<Transcript> {
    let base = string_at(track, &["baseUrl"]);
    let url = Url::parse(&base).ok()?;
    if !url.host_str().unwrap_or_default().ends_with(".youtube.com") {
        return None;
    }
    let headers = vec![("User-Agent".to_string(), "Mozilla/5.0".to_string())];
    let response = fetcher
        .fetch(request(&base, None, headers))
        .ok()
        .filter(|r| r.ok)?;
    if response.text.is_empty() {
        return None;
    }
    let language = Some(string_at(track, &["languageCode"]))
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "en".into());
    parse_transcript_xml(&response.text, &language, chapters)
        .ok()
        .flatten()
}

/// `fetchPlayerData(videoId)`: the first client whose answer has caption tracks, else the
/// page's own player response.
fn fetch_player_data(
    cx: &Cx,
    fetcher: &dyn Fetcher,
    video_id: &str,
) -> Result<Option<JsValue>, ExtractError> {
    let attempts = [
        (IOS_CONTEXT, json_headers(None)),
        (ANDROID_CONTEXT, json_headers(Some(ANDROID_USER_AGENT))),
        (WEB_CONTEXT, json_headers(None)),
    ];
    for (context, headers) in attempts {
        let body = innertube_body(context, video_id);
        let data = fetcher
            .fetch(request(PLAYER_URL, Some((headers, body)), Vec::new()))
            .ok()
            .filter(|r| r.ok)
            .and_then(|r| parse(&r.text).ok());
        if let Some(data) = data
            && !caption_tracks(Some(&data)).is_empty()
        {
            return Ok(Some(data));
        }
    }
    let fallback = parse_inline_json(cx, "ytInitialPlayerResponse")?;
    Ok(fallback.filter(|d| !caption_tracks(Some(d)).is_empty()))
}

impl YoutubeExtractor {
    /// `fetchTranscript()`.
    fn fetch_transcript(
        &self,
        cx: &Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Option<Transcript>, ExtractError> {
        let video_id = self.video_id()?;
        if video_id.is_empty() {
            return Ok(None);
        }
        let chapters = fetch_chapters(cx, fetcher, &video_id)?;
        let inline_tracks = caption_tracks(player_response(cx, &video_id)?.as_ref());
        let inline_track =
            pick_caption_track(&inline_tracks).filter(|t| !string_at(t, &["baseUrl"]).is_empty());
        let inline_result = inline_track.and_then(|t| fetch_caption_xml(fetcher, t, &chapters));
        let player = fetch_player_data(cx, fetcher, &video_id)?;
        let api_tracks = caption_tracks(player.as_ref());
        let api_track = if player.is_some() {
            pick_caption_track(&api_tracks)
        } else {
            None
        };
        let api_result = api_track
            .filter(|t| {
                let base = string_at(t, &["baseUrl"]);
                !base.is_empty() && Some(base) != inline_track.map(|i| string_at(i, &["baseUrl"]))
            })
            .and_then(|t| fetch_caption_xml(fetcher, t, &chapters));
        Ok(api_result.or(inline_result))
    }

    fn transcript_container(&self, cx: &Cx) -> Result<Option<NodeId>, ExtractError> {
        if let Some(desktop) = cx.qs(&format!("{TRANSCRIPT_PANEL} #segments-container"))? {
            return Ok(Some(desktop));
        }
        cx.qs("ytm-macro-markers-list-renderer .ytm-macro-markers-list-container")
    }

    fn transcript_language_from_dom(&self, cx: &Cx) -> Result<Option<String>, ExtractError> {
        let button = cx.qs(&format!(
            "{TRANSCRIPT_PANEL} #footer yt-sort-filter-sub-menu-renderer yt-dropdown-menu button"
        ))?;
        let selected = button.map(|b| trimmed(cx.doc, b)).unwrap_or_default();
        let tracks = caption_tracks(player_response(cx, &self.video_id()?)?.as_ref());
        let only = (tracks.len() == 1)
            .then(|| string_at(&tracks[0], &["languageCode"]))
            .filter(|l| !l.is_empty());
        if selected.is_empty() {
            return Ok(only);
        }
        let label = |s: &str| to_lower(trim(&RUNS.replace_all(&PAREN.replace_all(s, " "), " ")));
        let wanted = label(&selected);
        let matching = tracks.iter().find(|t| {
            let name = Some(string_at(t, &["name", "simpleText"]))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| match path(t, &["name", "runs"]) {
                    Some(JsValue::Array(runs)) => trim(
                        &runs
                            .iter()
                            .map(|r| string_at(r, &["text"]))
                            .collect::<String>(),
                    )
                    .to_string(),
                    _ => String::new(),
                });
            label(&name) == wanted
        });
        Ok(matching
            .map(|t| string_at(t, &["languageCode"]))
            .filter(|l| !l.is_empty())
            .or(only))
    }

    /// `buildTranscriptFromContainer(container, chapters)`.
    fn transcript_from_container(
        &self,
        cx: &Cx,
        container: NodeId,
        chapters: Vec<Chapter>,
    ) -> Result<Option<Transcript>, ExtractError> {
        if cx.doc.children(container).is_empty() {
            return Ok(None);
        }
        let (segments_sel, ts_sel, text_sel, chapter_sel) = if !cx
            .doc
            .query_selector_all(container, "ytd-transcript-segment-renderer")?
            .is_empty()
        {
            (
                "ytd-transcript-segment-renderer",
                ".segment-timestamp",
                ".segment-text",
                None,
            )
        } else if !cx
            .doc
            .query_selector_all(container, "transcript-segment-view-model")?
            .is_empty()
        {
            (
                "transcript-segment-view-model",
                ".ytwTranscriptSegmentViewModelTimestamp",
                "span.yt-core-attributed-string",
                Some("timeline-chapter-view-model h3"),
            )
        } else {
            return Ok(None);
        };
        let mut dom_chapters = Vec::new();
        if let Some(sel) = chapter_sel {
            for ch in cx.doc.query_selector_all(container, sel)? {
                let title = trimmed(cx.doc, ch);
                if title.is_empty() {
                    continue;
                }
                let item = cx.doc.closest(ch, "macro-markers-panel-item-view-model")?;
                let next = match item.and_then(|i| cx.doc.next_element_sibling(i)) {
                    Some(sib) => cx.doc.query_selector(sib, ts_sel)?,
                    None => None,
                };
                let time = next.map(|n| trimmed(cx.doc, n)).unwrap_or_default();
                if let Some(start) = parse_timestamp(&time) {
                    dom_chapters.push(Chapter { title, start });
                }
            }
        }
        let mut segments = Vec::new();
        for seg in cx.doc.query_selector_all(container, segments_sel)? {
            let (Some(ts), Some(text)) = (
                cx.doc.query_selector(seg, ts_sel)?,
                cx.doc.query_selector(seg, text_sel)?,
            ) else {
                continue;
            };
            let text = trimmed(cx.doc, text);
            if text.is_empty() {
                continue;
            }
            if let Some(start) = parse_timestamp(&trimmed(cx.doc, ts)) {
                segments.push(Raw { start, text });
            }
        }
        if segments.is_empty() {
            return Ok(None);
        }
        let effective = if chapters.is_empty() {
            dom_chapters
        } else {
            chapters
        };
        let groups: Vec<Segment> = group_transcript_segments(&segments);
        let (html, _) = build_transcript("youtube", &groups, &effective);
        Ok(Some(Transcript {
            html,
            language: self.transcript_language_from_dom(cx)?,
        }))
    }

    /// `extractTranscriptFromExistingDom()`: a failure logs and gives nothing.
    fn existing_dom_transcript(&self, cx: &Cx) -> Option<Transcript> {
        let attempt = || -> Result<Option<Transcript>, ExtractError> {
            let Some(container) = self.transcript_container(cx)? else {
                return Ok(None);
            };
            let chapters = inline_chapters(cx, &self.video_id()?)?;
            self.transcript_from_container(cx, container, chapters)
        };
        match attempt() {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(%error, "YoutubeExtractor: failed to extract transcript from existing DOM");
                None
            }
        }
    }
}

impl YoutubeExtractor {
    fn build_result(
        &self,
        cx: &Cx,
        transcript: Option<Transcript>,
    ) -> Result<Extracted, ExtractError> {
        let video_id = self.video_id()?;
        let data = video_data(cx, &video_id)?;
        let author = channel_name(cx, &video_id, &data)?;
        let description = string_at(&data, &["description"]);
        let mut content = format!(
            "<iframe width=\"560\" height=\"315\" src=\"https://www.youtube.com/embed/{video_id}\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen></iframe><p>{}</p>",
            description.replace('\n', "<br>")
        );
        let language = transcript
            .as_ref()
            .and_then(|t| t.language.clone())
            .unwrap_or_default();
        if let Some(t) = transcript.filter(|t| !t.html.is_empty()) {
            content.push_str(&t.html);
        }
        Ok(Extracted {
            content_html: content,
            content_selector: None,
            variables: Variables {
                title: string_at(&data, &["name"]),
                author,
                site: "YouTube".into(),
                published: string_at(&data, &["uploadDate"]),
                description: trim(&utf16_slice(&description, 0, 200)).to_string(),
                language,
            },
        })
    }
}

impl Extractor for YoutubeExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(true)
    }

    fn can_extract_async(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(true)
    }

    fn prefers_async(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let transcript = self.existing_dom_transcript(cx);
        self.build_result(cx, transcript)
    }

    fn extract_async(
        &mut self,
        cx: &mut Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        let existing = self.existing_dom_transcript(cx);
        if existing.is_some() {
            return self.build_result(cx, existing);
        }
        let transcript = self.fetch_transcript(cx, fetcher)?;
        self.build_result(cx, transcript)
    }
}
