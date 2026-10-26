//! `dist/utils/transcript.js`: the transcript markup shared by the video extractors.

use super::dom::escape_html;
use super::json::number_to_string;

/// One grouped transcript segment.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub text: String,
    pub speaker: Option<u8>,
    pub speaker_change: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub title: String,
    pub start: f64,
}

/// `formatTimestamp(seconds)`: `M:SS` or `H:MM:SS`.
pub fn format_timestamp(seconds: f64) -> String {
    let h = (seconds / 3600.0).floor();
    let m = ((seconds % 3600.0) / 60.0).floor();
    let s = (seconds % 60.0).floor();
    if h > 0.0 {
        format!("{}:{:02}:{:02}", number_to_string(h), m as i64, s as i64)
    } else {
        format!("{}:{:02}", number_to_string(m), s as i64)
    }
}

/// `buildTranscript(site, segments, chapters)`: the HTML and the text.
pub fn build_transcript(
    site: &str,
    segments: &[Segment],
    chapters: &[Chapter],
) -> (String, String) {
    let mut sorted = chapters.to_vec();
    sorted.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut chapter_idx = 0;
    let mut html = Vec::new();
    let mut text: Vec<String> = Vec::new();
    for segment in segments {
        while chapter_idx < sorted.len() && sorted[chapter_idx].start <= segment.start {
            let title = &sorted[chapter_idx].title;
            html.push(format!("<h3>{}</h3>", escape_html(title)));
            if !text.is_empty() {
                text.push(String::new());
            }
            text.push(format!("### {title}"));
            text.push(String::new());
            chapter_idx += 1;
        }
        let timestamp = format_timestamp(segment.start);
        let speaker_class = segment
            .speaker
            .map(|s| format!(" speaker-{s}"))
            .unwrap_or_default();
        let ts_html = format!(
            "<strong><span class=\"timestamp\" data-timestamp=\"{}\">{timestamp}</span></strong>",
            number_to_string(segment.start)
        );
        html.push(format!(
            "<p class=\"transcript-segment{speaker_class}\">{ts_html} · {}</p>",
            escape_html(&segment.text)
        ));
        if segment.speaker_change && !text.is_empty() {
            text.push(String::new());
        }
        text.push(format!("**{timestamp}** · {}", segment.text));
    }
    (
        format!(
            "<div class=\"{site} transcript\">\n<h2>Transcript</h2>\n{}\n</div>",
            html.join("\n")
        ),
        text.join("\n"),
    )
}
