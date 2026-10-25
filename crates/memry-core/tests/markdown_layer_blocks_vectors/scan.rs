//! `scan.all` of the oracle: every reader at every line of a document, the way
//! the pipeline walks it.

use memry_core::markdown::schema::blocks::callout::{read_callout_run, resolve_callout_run};
use memry_core::markdown::schema::blocks::embeds::{
    bookmark_line_url, parse_whiteboard_line, parse_youtube_embed_line,
};
use memry_core::markdown::schema::blocks::file::{is_file_block_line, parse_file_block_marker};
use memry_core::markdown::schema::blocks::math::read_math_run;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::markdown::schema::quote::{read_structured_quote_run, resolve_quote_run};
use serde_json::{Value, json};

use crate::stubs::{Stub, js_trim};

pub fn scan_all(markdown: &str, custom: &CalloutTypes) -> Result<Value, String> {
    let lines: Vec<String> = markdown.split('\n').map(str::to_owned).collect();
    let stub = Stub::Mini;
    let mut callouts = Vec::new();
    let mut quotes = Vec::new();
    let mut math = Vec::new();
    let mut markers = Vec::new();
    for i in 0..lines.len() {
        let at_start = i == 0 || js_trim(&lines[i - 1]).is_empty();
        if let Some(run) = read_callout_run(&lines, i, at_start, custom) {
            let resolved = resolve_callout_run(&run, custom, &mut |m| stub.parse(m), &mut |b| {
                stub.serialize(b)
            })?;
            callouts.push(json!({"i": i, "run": run, "resolved": resolved}));
        }
        if let Some(run) = read_structured_quote_run(&lines, i) {
            let resolved =
                resolve_quote_run(&run, &mut |m| stub.parse(m), &mut |b| stub.serialize(b))?;
            quotes.push(json!({"i": i, "run": run, "resolved": resolved}));
        }
        if let Some(run) = read_math_run(&lines, i, at_start) {
            math.push(json!({"i": i, "run": run}));
        }
        let trimmed = js_trim(&lines[i]);
        if is_file_block_line(trimmed) {
            markers
                .push(json!({"i": i, "kind": "file", "props": parse_file_block_marker(trimmed)}));
        }
        if let Some(url) = bookmark_line_url(&lines[i]) {
            markers.push(json!({"i": i, "kind": "bookmark", "url": url}));
        }
        if let Some(youtube) = parse_youtube_embed_line(&lines[i]) {
            markers.push(json!({
                "i": i, "kind": "youtube", "videoId": youtube.video_id,
                "videoUrl": youtube.video_url, "alt": youtube.alt
            }));
        }
        if let Some(canvas) = parse_whiteboard_line(&lines[i]) {
            markers.push(json!({"i": i, "kind": "whiteboard", "canvasId": canvas}));
        }
    }
    Ok(json!({"callouts": callouts, "quotes": quotes, "math": math, "markers": markers}))
}
