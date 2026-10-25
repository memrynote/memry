//! The regex literals of `dist/removals/content-patterns.js`, translated for the `regex` crate.
//!
//! A JS regex without the `u` flag folds case for ASCII only and reads `\b`, `\d`, `\w` as
//! ASCII, `\s` as the JS whitespace set and `.` as "not a line terminator". Each pattern spells
//! that out: `(?i-u:...)` islands for the case-insensitive ASCII words, `[0-9]`, `(?-u:\b)`, the
//! `WS` class and `LINE_CHAR`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::{WS, WS_BODY};

const MONTHS3: &str = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const MONTHS_FULL: &str = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const WEEKDAYS: &str = "Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?";
/// JS `.`.
const LINE_CHAR: &str = r"[^\n\r\x{2028}\x{2029}]";
const B: &str = r"(?-u:\b)";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|e| panic!("static pattern {pattern}: {e}"))
}

/// `CONTENT_DATE_PATTERN`.
pub static CONTENT_DATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "(?:(?i-u:(?:{MONTHS3})[a-z]*){WS}+[0-9]{{1,2}}|[0-9]{{1,2}}(?i-u:(?:st|nd|rd|th)?){WS}+(?i-u:(?:{MONTHS3})[a-z]*)|[0-9]{{4}}[-/][0-9]{{1,2}}[-/][0-9]{{1,2}})"
    ))
});

/// `RELATIVE_TIME_PATTERN`.
pub static RELATIVE_TIME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "{B}[0-9]+{WS}+(?i-u:(?:second|minute|hour|day|week|month|year)s?){WS}+(?i-u:ago){B}"
    ))
});

/// `CONTENT_READ_TIME_PATTERN`.
pub static CONTENT_READ_TIME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "[0-9]+{WS}*(?i-u:min(?:ute)?s?){WS}+(?i-u:read){B}|(?i-u:read(?:ing)?){WS}+(?i-u:time){WS}*:?{WS}*[0-9]+{WS}*(?i-u:min(?:ute)?s?){B}"
    ))
});

/// `BYLINE_UPPERCASE_PATTERN`.
pub static BYLINE_UPPERCASE_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"^\p{Lu}"));

/// `STARTS_WITH_BY_PATTERN`.
pub static STARTS_WITH_BY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^(?:(?i-u:posted){WS}+)?(?i-u:by){WS}+[^{WS_BODY}]"
    ))
});

/// `METADATA_LABEL_PATTERN`.
pub static METADATA_LABEL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^(?i-u:(?:date|published|updated|posted|from|to|subject)){WS}*:"
    ))
});

/// `BOILERPLATE_PATTERNS`, in order.
pub static BOILERPLATE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!(
            "^(?i-u:This (?:article|story|piece) (?:appeared|was published|originally appeared) in){B}"
        )),
        re(&format!(
            "^(?i-u:A version of this (?:article|story) (?:appeared|was published) in){B}"
        )),
        re(&format!(
            "^(?i-u:Originally (?:published|appeared) (?:in|on|at)){B}"
        )),
        re(&format!("^(?i-u:Any re-?use permitted){B}")),
        re(&format!("^©{WS}*(?:(?i-u:Copyright){WS}+)?[0-9]{{4}}")),
        re("^(?i-u:Comments?)$"),
        re("^(?i-u:Leave a (?:comment|reply))$"),
        re(r"^Loading\.{3}$"),
        re(&format!(
            "^(?i-u:Affiliate links){B}{LINE_CHAR}*{B}(?i-u:(?:earn|commission))"
        )),
        re(&format!("{B}(?i-u:Read our Comment Policy){B}")),
        re(&format!(
            "^(?i-u:Thank you for (?:being part of|joining) our community){B}"
        )),
    ]
});

/// `NEWSLETTER_PATTERN`. `[\s\S]{0,40}` counts UTF-16 units in JS and scalars here, so the text
/// is passed through `expand_astral` first.
pub static NEWSLETTER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "{B}(?i-u:subscribe){B}(?s:.){{0,40}}{B}(?i-u:newsletter){B}\
         |{B}(?i-u:newsletter){B}(?s:.){{0,40}}{B}(?i-u:subscribe){B}\
         |{B}(?i-u:sign)[- ](?i-u:up){B}(?s:.){{0,80}}{B}(?i-u:(?:newsletter|email alert))\
         |{B}(?:(?i-u:don)['\u{2019}]?(?i-u:t (?:want to )?miss)|(?i-u:never miss)){B}(?s:.){{0,80}}{B}(?i-u:(?:latest|best|exclusive|reports?|updates?|source))"
    ))
});

/// An astral character is two UTF-16 units; give it two scalars so a counted gap in a pattern
/// spans the same text as in JS.
pub fn expand_astral(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        out.push(c);
        if c.len_utf16() == 2 {
            out.push('\u{fffd}');
        }
    }
    out
}

/// `SOCIAL_COUNTER_PATTERN`.
pub static SOCIAL_COUNTER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^[0-9]+{WS}+(?i-u:(?:Likes?|Comments?|Shares?|Retweets?|Reposts?|Restacks?))$"
    ))
});

pub static TIMEZONE_WIDGET_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| re("^(?i-u:current time in)$"));
pub static PINNED_LABEL_PATTERN: LazyLock<Regex> = LazyLock::new(|| re("^(?i-u:pinned)$"));

/// `AUTHOR_CONTACT_LABEL_PATTERN`.
pub static AUTHOR_CONTACT_LABEL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| re("^(?i-u:(?:written by|(?:author|contact|reporter|correspondent)s?))$"));

/// `SHARE_AUTHOR_LABEL`.
pub static SHARE_AUTHOR_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^(?:(?i-u:share|follow|authors?)|(?i-u:written){WS}+(?i-u:by))$"
    ))
});

/// `EMAIL_PATTERN`.
pub static EMAIL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| re(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+\.[A-Za-z0-9_]+"));

/// `PHONE_PATTERN`: the separator class holds whitespace, a dot, U+2011, U+2013 and a hyphen.
pub static PHONE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"\(?[0-9]{{3}}\)?[{WS_BODY}.\x{{2011}}\x{{2013}}-]?[0-9]{{3}}[{WS_BODY}.\x{{2011}}\x{{2013}}-]?[0-9]{{4}}"
    ))
});

/// `RELATED_HEADING_PATTERN`.
pub static RELATED_HEADING_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let latest_tail = format!("(?:{WS}*[&+]{WS}*(?i-u:(?:news|events?|posts?|articles?|stories)))");
    re(&format!(
        "^(?:(?i-u:related (?:posts?|articles?|content|stories|reads?|reading)\
         |you (?:might|may|could) (?:also )?(?:like|enjoy|be interested in)\
         |read (?:next|more|also)|further reading|see also\
         |more (?:from|articles?|posts?|like this)\
         |more to (?:read|explore)|explore more|about (?:the )?author)\
         |(?i-u:more from ){LINE_CHAR}*\
         |(?i-u:latest (?:news|events?|posts?|articles?|stories)){latest_tail}?)$"
    ))
});

/// `CTA_HEADING_PATTERN`.
pub static CTA_HEADING_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        "^(?i-u:(?:subscribe|sign up|follow us|share this|stay (?:updated|connected)|join (?:us|our)|search (?:the |our )?(?:site|blog|archives?|newsroom|website|catalog|store|shop|database)))$",
    )
});

/// `RELATED_INTRO_PATTERN`.
pub static RELATED_INTRO_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("^(?i-u:for more (?:on|about)){B}")));

/// The table-of-contents label of a heading.
pub static TOC_LABEL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        "^(?i-u:(?:table of )?contents)$|^(?i-u:on this page)$|^(?i-u:in this (?:article|guide|post))$",
    )
});

/// `/\blisten\s+to\s+(?:this\s+)?(?:article|story|post|episode|podcast)\b/i`.
pub static LISTEN_WIDGET_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "{B}(?i-u:listen){WS}+(?i-u:to){WS}+(?:(?i-u:this){WS}+)?(?i-u:(?:article|story|post|episode|podcast)){B}"
    ))
});

/// `/^\/[a-zA-Z0-9_-]+\/?$/`: a shallow path.
pub static SHALLOW_PATH_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"^/[a-zA-Z0-9_-]+/?$"));

/// `/^index\.(html?|php)$/i`.
pub static INDEX_FILE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?i-u:index\.(?:html?|php))$"));

/// `/[.!?]/`, `/[.!?]\s/` and `/[.!?]$/`.
pub fn has_sentence_punctuation(text: &str) -> bool {
    text.contains(['.', '!', '?'])
}

pub static PUNCTUATION_THEN_SPACE: LazyLock<Regex> = LazyLock::new(|| re(&format!("[.!?]{WS}")));
pub static ENDS_WITH_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| re("[.!?]$"));

/// `METADATA_STRIP_BASE`: month, weekday and ordinal-number words and ISO dates, global.
static METADATA_STRIP_BASE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!("{B}(?i-u:(?:{MONTHS_FULL})){B}")),
        re(&format!("{B}(?i-u:(?:{WEEKDAYS})){B}")),
        re(&format!("{B}[0-9]+(?:st|nd|rd|th)?{B}")),
        re("[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}"),
    ]
});

fn strip(text: &str, patterns: &[Regex]) -> String {
    let mut out = text.to_string();
    for pattern in patterns {
        out = pattern.replace_all(&out, "").into_owned();
    }
    out
}

static READ_TIME_STRIP_EXTRA: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!("{B}(?i-u:min(?:ute)?s?){B}")),
        re(&format!("{B}(?i-u:read(?:ing)?){B}")),
        re(&format!("{B}(?i-u:time){B}")),
        re(&format!("{B}(?i-u:estimated){B}")),
        re(&format!(
            "[/|\u{b7}\u{2022}\u{2014}\u{2013}\\-,:.{WS_BODY}]+"
        )),
    ]
});

static BYLINE_STRIP_EXTRA: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(&format!("{B}(?i-u:by){B}")),
        re("[/|\u{b7}\u{2022}\u{2014}\u{2013}\\-,]+"),
    ]
});

static DATE_ONLY_RESIDUAL: LazyLock<Regex> = LazyLock::new(|| re(&format!("[,{WS_BODY}/\\-]+")));

/// `READ_TIME_STRIP_PATTERNS` applied in order with `replace(pattern, '')`.
pub fn strip_read_time(text: &str) -> String {
    strip(&strip(text, &METADATA_STRIP_BASE), &READ_TIME_STRIP_EXTRA)
}

/// `BYLINE_STRIP_PATTERNS` applied in order.
pub fn strip_byline(text: &str) -> String {
    strip(&strip(text, &METADATA_STRIP_BASE), &BYLINE_STRIP_EXTRA)
}

/// `METADATA_STRIP_BASE` followed by `replace(/[,\s/\-]+/g, '')`.
pub fn strip_date_only(text: &str) -> String {
    let stripped = strip(text, &METADATA_STRIP_BASE);
    DATE_ONLY_RESIDUAL.replace_all(&stripped, "").into_owned()
}

/// `text.replace(/([a-z])([A-Z])/g, '$1 $2')` for newsletter matching.
static CAMEL_BOUNDARY: LazyLock<Regex> = LazyLock::new(|| re("([a-z])([A-Z])"));

pub fn split_camel_case(text: &str) -> String {
    CAMEL_BOUNDARY.replace_all(text, "$1 $2").into_owned()
}
