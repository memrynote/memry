//! `YoutubeExtractor.groupTranscriptSegments` and its helpers: raw caption segments grouped into
//! readable blocks, by speaker turn when the captions carry `>>` or `- ` markers, else by
//! sentence.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::{WS, is_js_whitespace, trim};
use crate::web::extract::utils::text::count_words;
use crate::web::extract::utils::transcript::Segment;

const GROUP_GAP: f64 = 20.0;
const MAX_GROUP: f64 = 30.0;
const TURN_MERGE_MAX_WORDS: usize = 80;
const TURN_MERGE_MAX_SPAN: f64 = 45.0;
const SHORT_UTTERANCE_MAX_WORDS: usize = 3;
const FIRST_GROUP_MERGE_MIN_WORDS: usize = 8;
const CJK: &str = r"\x{3040}-\x{309f}\x{30a0}-\x{30ff}\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}\x{ac00}-\x{d7af}";
/// `.` of JS: anything but a line terminator.
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

static SENTENCE_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "[.!?\u{3002}\u{FF01}\u{FF1F}][\"'\u{2019}\u{201D})\u{300D}\u{300F}\u{FF09}]*{WS}*$"
    ))
    .expect("static")
});
static QUESTION_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "[?\u{FF1F}][\"'\u{2019}\u{201D})\u{300D}\u{300F}\u{FF09}]*{WS}*$"
    ))
    .expect("static")
});
static SPEAKER_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^(>>|-{WS})")).expect("static"));
static SPEAKER_STRIP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^(>>{WS}*|-{WS}+)")).expect("static"));
static TRAILING_COMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r",{WS}*$")).expect("static"));
static MID_BOUNDARY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^({DOT}*[.!?][\"'\u{2019}\u{201D})]*){WS}+([A-Z]{DOT}*)$|^({DOT}*[\u{3002}\u{FF01}\u{FF1F}][\u{300D}\u{300F}\u{FF09}]*)([{CJK}]{DOT}*)$"
    ))
    .expect("static")
});
static AFFIRMATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?i-u:(mhm|yeah|yes|yep|right|okay|ok|absolutely|sure|exactly|uh-huh|mm-hmm))[.!,]?{WS}+"
    ))
    .expect("static")
});

#[derive(Debug, Clone)]
pub struct Raw {
    pub start: f64,
    pub text: String,
}

struct Turn {
    start: f64,
    segments: Vec<Raw>,
    speaker_change: bool,
    speaker: Option<u8>,
}

#[derive(Clone)]
struct Group {
    start: f64,
    text: String,
}

fn push_group(groups: &mut Vec<Group>, segs: &[Raw]) {
    let text = trim(
        &segs
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
    )
    .to_string();
    if !text.is_empty() {
        groups.push(Group {
            start: segs[0].start,
            text,
        });
    }
}

/// `findNaturalBreak(segments)`: may split a segment in two. `None` is JS `-1`.
fn find_natural_break(segments: &mut Vec<Raw>) -> i64 {
    if segments.len() <= 1 {
        return -1;
    }
    let min_start = segments[0].start + MAX_GROUP / 2.0;
    for i in (0..segments.len()).rev() {
        if segments[i].start < min_start {
            break;
        }
        if let Some(m) = MID_BOUNDARY.captures(&segments[i].text) {
            let before = m
                .get(1)
                .or_else(|| m.get(3))
                .map(|g| g.as_str().to_string())
                .unwrap_or_default();
            let after = m
                .get(2)
                .or_else(|| m.get(4))
                .map(|g| g.as_str().to_string())
                .unwrap_or_default();
            let start = segments[i].start;
            segments.splice(
                i..=i,
                [
                    Raw {
                        start,
                        text: before,
                    },
                    Raw { start, text: after },
                ],
            );
            return i as i64 + 1;
        }
    }
    let (mut best_idx, mut best_gap) = (-1i64, 0.0f64);
    for i in 1..segments.len() {
        if segments[i].start < min_start {
            continue;
        }
        let gap = segments[i].start - segments[i - 1].start;
        if gap >= best_gap {
            best_gap = gap;
            best_idx = i as i64;
        }
    }
    best_idx
}

fn group_by_sentence(segments: &[Raw]) -> Vec<Group> {
    let mut groups = Vec::new();
    let mut pending: Vec<Raw> = Vec::new();
    for seg in segments {
        if let Some(last) = pending.last()
            && seg.start - last.start > GROUP_GAP
        {
            push_group(&mut groups, &pending);
            pending.clear();
        }
        pending.push(seg.clone());
        if SENTENCE_END.is_match(&seg.text) {
            push_group(&mut groups, &pending);
            pending.clear();
            continue;
        }
        if seg.start - pending[0].start >= MAX_GROUP {
            let break_idx = find_natural_break(&mut pending);
            if break_idx > 0 && (break_idx as usize) < pending.len() {
                let head: Vec<Raw> = pending.drain(..break_idx as usize).collect();
                push_group(&mut groups, &head);
            } else {
                push_group(&mut groups, &pending);
                pending.clear();
            }
        }
    }
    if !pending.is_empty() {
        push_group(&mut groups, &pending);
    }
    groups
}

fn is_short_standalone(text: &str, words: usize) -> bool {
    words > 0 && words <= SHORT_UTTERANCE_MAX_WORDS && SENTENCE_END.is_match(text)
}

fn should_merge(current: &Group, next: &Group, current_is_first: bool) -> bool {
    let (cw, nw) = (count_words(&current.text), count_words(&next.text));
    if is_short_standalone(&current.text, cw) || is_short_standalone(&next.text, nw) {
        return false;
    }
    if current_is_first && cw < FIRST_GROUP_MERGE_MIN_WORDS {
        return false;
    }
    if QUESTION_END.is_match(&current.text) || QUESTION_END.is_match(&next.text) {
        return false;
    }
    if cw + nw > TURN_MERGE_MAX_WORDS {
        return false;
    }
    // `!(a > b)`, not `a <= b`: a NaN start (an unparsable `<text start>`) merges in JS.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    let within_span = !(next.start - current.start > TURN_MERGE_MAX_SPAN);
    within_span
}

fn merge_within_turn(groups: Vec<Group>) -> Vec<Group> {
    if groups.len() <= 1 {
        return groups;
    }
    let mut merged = Vec::new();
    let mut current = groups[0].clone();
    let mut first = true;
    for next in &groups[1..] {
        if should_merge(&current, next, first) {
            current.text = format!("{} {}", current.text, next.text);
            continue;
        }
        merged.push(current);
        current = next.clone();
        first = false;
    }
    merged.push(current);
    merged
}

fn split_affirmative_turns(turns: &mut Vec<Turn>) {
    let mut i = 0;
    while i < turns.len() {
        let turn = &turns[i];
        let Some(speaker) = turn.speaker else {
            i += 1;
            continue;
        };
        if turn.segments.is_empty() {
            i += 1;
            continue;
        }
        let first = &turn.segments[0];
        let Some(m) = AFFIRMATIVE.find(&first.text) else {
            i += 1;
            continue;
        };
        if m.as_str()
            .trim_end_matches(|c: char| is_js_whitespace(c))
            .ends_with(',')
        {
            i += 1;
            continue;
        }
        let remainder = trim(&first.text[m.end()..]).to_string();
        let rest: Vec<Raw> = turn.segments[1..].to_vec();
        let rest_words =
            count_words(&remainder) + rest.iter().map(|s| count_words(&s.text)).sum::<usize>();
        if rest_words < 30 {
            i += 1;
            continue;
        }
        let affirmative = m.as_str().trim_end_matches(is_js_whitespace).to_string();
        let first_start = first.start;
        let new_rest: Vec<Raw> = if remainder.is_empty() {
            rest
        } else {
            std::iter::once(Raw {
                start: first_start,
                text: remainder,
            })
            .chain(rest)
            .collect()
        };
        let affirmative_turn = Turn {
            start: turn.start,
            segments: vec![Raw {
                start: first_start,
                text: affirmative,
            }],
            speaker_change: turn.speaker_change,
            speaker: Some(speaker),
        };
        let rest_turn = Turn {
            start: new_rest[0].start,
            segments: new_rest,
            speaker_change: true,
            speaker: Some(u8::from(speaker == 0)),
        };
        turns.splice(i..=i, [affirmative_turn, rest_turn]);
        i += 2;
    }
}

fn group_by_speaker(segments: &[Raw]) -> Vec<Segment> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut current: Option<Turn> = None;
    let mut speaker_index: i32 = -1;
    let mut prev = String::new();
    for seg in segments {
        let is_change = SPEAKER_MARKER.is_match(&seg.text);
        let clean = SPEAKER_STRIP.replace(&seg.text, "").into_owned();
        let prev_comma = TRAILING_COMMA.is_match(&prev);
        let prev_ended = (SENTENCE_END.is_match(&prev) || prev.is_empty()) && !prev_comma;
        if is_change && prev_ended {
            if let Some(t) = current.take() {
                turns.push(t);
            }
            speaker_index = (speaker_index + 1) % 2;
            current = Some(Turn {
                start: seg.start,
                segments: vec![Raw {
                    start: seg.start,
                    text: clean.clone(),
                }],
                speaker_change: true,
                speaker: Some(speaker_index as u8),
            });
        } else {
            current
                .get_or_insert_with(|| Turn {
                    start: seg.start,
                    segments: Vec::new(),
                    speaker_change: false,
                    speaker: None,
                })
                .segments
                .push(Raw {
                    start: seg.start,
                    text: clean.clone(),
                });
        }
        prev = clean;
    }
    if let Some(t) = current {
        turns.push(t);
    }
    split_affirmative_turns(&mut turns);
    let mut out = Vec::new();
    for turn in &turns {
        let sentences = group_by_sentence(&turn.segments);
        let sentences = if turn.speaker.is_none() {
            sentences
        } else {
            merge_within_turn(sentences)
        };
        for (i, g) in sentences.into_iter().enumerate() {
            out.push(Segment {
                start: g.start,
                text: g.text,
                speaker: turn.speaker,
                speaker_change: i == 0 && turn.speaker_change,
            });
        }
    }
    out
}

/// `groupTranscriptSegments(segments)`.
pub fn group_transcript_segments(segments: &[Raw]) -> Vec<Segment> {
    if segments.is_empty() {
        return Vec::new();
    }
    if segments.iter().any(|s| SPEAKER_MARKER.is_match(&s.text)) {
        return group_by_speaker(segments);
    }
    group_by_sentence(segments)
        .into_iter()
        .map(|g| Segment {
            start: g.start,
            text: g.text,
            speaker: None,
            speaker_change: false,
        })
        .collect()
}
