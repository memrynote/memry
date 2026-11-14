//! The model contract of the fold (`engine.ts`): the prompt for one chunk, the reply it must
//! give (`chunkAiSchema`), the fallback lines of a chunk the model has not written
//! (`truncateUnits`), and the words each level shows (`levelWords`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};

use super::sections::ParsedChunk;
use super::text::{count_words, is_cjk};
use super::{FoldKey, FoldLevel, FoldSection};

/// What the model wrote for one paragraph (`ChunkParagraphAi`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkParagraphAi {
    /// Source sentence indices, in order, that make the Brief line.
    pub brief: Vec<u32>,
    pub key: FoldKey,
    pub takeaway: String,
    pub topic: String,
    /// Source sentence indices the model lines rest on.
    pub evidence: Vec<u32>,
}

/// What the model wrote for one chunk (`ChunkAi`), as the cache row holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkAi {
    pub section_takeaway: String,
    pub paragraphs: Vec<ChunkParagraphAi>,
}

/// `chunkAiSchema(chunk).parse`: the reply's shape, one paragraph per source paragraph and
/// sentence indices inside each paragraph. Strings come back trimmed (zod's `.trim()`) and
/// unknown keys dropped. The error names the first problem.
pub fn chunk_ai(value: &Value, chunk: &ParsedChunk) -> Result<ChunkAi, String> {
    let object = as_object(value, "reply")?;
    let section_takeaway = line(object, "sectionTakeaway")?;
    let paragraphs = object
        .get("paragraphs")
        .and_then(Value::as_array)
        .ok_or("paragraphs: expected an array")?
        .iter()
        .enumerate()
        .map(|(i, p)| paragraph(p).map_err(|error| format!("paragraphs[{i}].{error}")))
        .collect::<Result<Vec<_>, _>>()?;
    // `superRefine` runs only on a reply of the right shape.
    if paragraphs.len() != chunk.paragraphs.len() {
        return Err(format!(
            "expected {} paragraphs, got {}",
            chunk.paragraphs.len(),
            paragraphs.len()
        ));
    }
    for (i, (p, source)) in paragraphs.iter().zip(&chunk.paragraphs).enumerate() {
        let count = source.sentences.len();
        if p.brief
            .iter()
            .chain(&p.evidence)
            .any(|&n| n as usize >= count)
        {
            return Err(format!("paragraph {i}: sentence index out of range"));
        }
    }
    Ok(ChunkAi {
        section_takeaway,
        paragraphs,
    })
}

fn as_object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

/// `z.string().trim().min(1)`.
fn line(object: &Map<String, Value>, field: &str) -> Result<String, String> {
    let text = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}: expected a string"))?;
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Err(format!("{field}: empty"));
    }
    Ok(trimmed.to_owned())
}

/// `z.array(z.number().int().nonnegative())`, with `.min(1)` when `min_one`. An index too large
/// for any paragraph reads as `u32::MAX`, which the range check then refuses.
fn indices(object: &Map<String, Value>, field: &str, min_one: bool) -> Result<Vec<u32>, String> {
    let items = object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{field}: expected an array"))?;
    if min_one && items.is_empty() {
        return Err(format!("{field}: empty"));
    }
    items
        .iter()
        .map(|item| {
            let n = item
                .as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
                .ok_or_else(|| format!("{field}: expected a non-negative integer"))?;
            Ok(if n >= f64::from(u32::MAX) {
                u32::MAX
            } else {
                n as u32
            })
        })
        .collect()
}

fn paragraph(value: &Value) -> Result<ChunkParagraphAi, String> {
    let object = as_object(value, "paragraph")?;
    let key = as_object(object.get("key").unwrap_or(&Value::Null), "key")?;
    Ok(ChunkParagraphAi {
        brief: indices(object, "brief", true)?,
        key: FoldKey {
            takeaway: line(key, "takeaway").map_err(|e| format!("key.{e}"))?,
            reason: line(key, "reason").map_err(|e| format!("key.{e}"))?,
        },
        takeaway: line(object, "takeaway")?,
        topic: line(object, "topic")?,
        evidence: indices(object, "evidence", false)?,
    })
}

/// `buildChunkPrompt`.
pub fn build_chunk_prompt(chunk: &ParsedChunk, language: &str) -> String {
    let mut lines = vec![
        "You summarize one section of a note at several levels of detail.".to_owned(),
        format!(
            "Write every summary line in the note's own language ({language}). Never translate."
        ),
        "Reply with ONLY one JSON object, no prose, no code fence, shaped exactly:".to_owned(),
        r#"{"sectionTakeaway": string, "paragraphs": [{"brief": number[], "key": {"takeaway": string, "reason": string}, "takeaway": string, "topic": string, "evidence": number[]}]}"#.to_owned(),
        "Rules:".to_owned(),
        r#"- "paragraphs" has exactly one entry per source paragraph, in order."#.to_owned(),
        r#"- "brief": 0-based indices of the source sentences that best carry the paragraph; they are shown verbatim."#.to_owned(),
        r#"- "key": takeaway = the claim in one sentence; reason = why it holds or matters, one sentence."#.to_owned(),
        r#"- "takeaway": one short line. "topic": 2-5 words naming the paragraph."#.to_owned(),
        r#"- "sectionTakeaway": one sentence for the whole section."#.to_owned(),
        r#"- "evidence": 0-based indices of the sentences your lines rest on."#.to_owned(),
        "- Use only what the text says. No new facts.".to_owned(),
        String::new(),
        format!(
            "Section heading: {}",
            chunk.heading.as_deref().unwrap_or("(none)")
        ),
        String::new(),
    ];
    for (i, p) in chunk.paragraphs.iter().enumerate() {
        lines.push(format!("Paragraph {i}:"));
        for (j, s) in p.sentences.iter().enumerate() {
            lines.push(format!("  [{j}] {s}"));
        }
    }
    lines.join("\n")
}

/// `truncateUnits`: the first `units` words (twice as many characters in Chinese, Japanese and
/// Korean), with `…` when cut.
pub fn truncate_units(text: &str, language: &str, units: usize) -> String {
    let t = js_trim(text);
    if is_cjk(language) {
        let chars: Vec<char> = t.chars().collect();
        return if chars.len() <= units * 2 {
            t.to_owned()
        } else {
            format!("{}…", chars[..units * 2].iter().collect::<String>())
        };
    }
    let words: Vec<&str> = t
        .split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() <= units {
        t.to_owned()
    } else {
        format!("{}…", words[..units].join(" "))
    }
}

/// `levelWords`: the words a level shows. Full is the whole text; the others sum their lines.
pub fn level_words(sections: &[FoldSection], level: FoldLevel, language: &str) -> u32 {
    let w = |t: Option<&str>| t.map_or(0, |t| count_words(t, language));
    let mut total = 0;
    for s in sections {
        if level == FoldLevel::Topic {
            total += w(s.heading.as_deref()) + w(s.takeaway.as_deref());
        }
        for p in &s.paragraphs {
            total += match level {
                FoldLevel::Brief => p
                    .brief_idx
                    .iter()
                    .map(|&i| w(Some(p.sentences.get(i as usize).map_or("", String::as_str))))
                    .sum(),
                FoldLevel::Key => {
                    w(p.key.as_ref().map(|k| k.takeaway.as_str()))
                        + w(p.key.as_ref().map(|k| k.reason.as_str()))
                }
                FoldLevel::Takeaway => w(Some(&p.takeaway)),
                FoldLevel::Topic => w(Some(&p.topic)),
                FoldLevel::Full => w(Some(&p.text)),
            };
        }
    }
    total
}
