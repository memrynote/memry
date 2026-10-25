//! `buildFrontmatter` of `dist/frontmatter.js`: a YAML block from extracted metadata.

use crate::web::extract::utils::js::is_js_whitespace;
use crate::web::extract::utils::text::count_words;

/// The fields of Defuddle's result that `buildFrontmatter` reads. An absent or empty string and
/// a zero `word_count` are falsy in JS and print nothing.
#[derive(Debug, Default, Clone)]
pub struct FrontmatterFields {
    pub title: Option<String>,
    pub author: Option<String>,
    pub site: Option<String>,
    pub published: Option<String>,
    pub domain: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub word_count: Option<u64>,
}

/// `text.charCodeAt(i)` ranges `truncateWords` treats as one word per character: Hiragana,
/// Katakana, CJK extension A, the CJK unified block, compatibility ideographs and Hangul.
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x309f
            | 0x30a0..=0x30ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0xac00..=0xd7af
    )
}

/// `truncateWords(text, maxWords)`: the text cut before the word that passes `maxWords`, with
/// the trailing whitespace trimmed and an ellipsis appended. Only characters up to U+0020 end a
/// word here, not the other whitespace of `\s`.
fn truncate_words(text: &str, max_words: usize) -> String {
    let mut words = 0;
    let mut in_word = false;
    for (index, c) in text.char_indices() {
        if is_cjk(c) {
            words += 1;
            in_word = false;
        } else if (c as u32) <= 32 {
            in_word = false;
        } else if !in_word {
            words += 1;
            in_word = true;
        }
        if words > max_words {
            return format!("{}…", text[..index].trim_end_matches(is_js_whitespace));
        }
    }
    text.to_string()
}

/// `s.replace(/"/g, '\\"').replace(/\n/g, ' ')`.
fn escape(s: &str) -> String {
    s.replace('"', "\\\"").replace('\n', " ")
}

fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// The block `"---\n…\n---\n\n"`. `source` prints only for a non-empty `source_url`.
pub fn build_frontmatter(result: &FrontmatterFields, source_url: Option<&str>) -> String {
    let mut lines = vec!["---".to_string()];
    if let Some(title) = present(&result.title) {
        lines.push(format!("title: \"{}\"", escape(title)));
    }
    if let Some(author) = present(&result.author) {
        lines.push(format!("author: \"{}\"", escape(author)));
    }
    if let Some(site) = present(&result.site) {
        lines.push(format!("site: \"{}\"", escape(site)));
    }
    if let Some(published) = present(&result.published) {
        lines.push(format!("published: {published}"));
    }
    if let Some(url) = source_url.filter(|u| !u.is_empty()) {
        lines.push(format!("source: \"{url}\""));
    }
    if let Some(domain) = present(&result.domain) {
        lines.push(format!("domain: \"{domain}\""));
    }
    if let Some(language) = present(&result.language) {
        lines.push(format!("language: \"{language}\""));
    }
    if let Some(description) = present(&result.description) {
        let description = if count_words(description) > 300 {
            truncate_words(description, 300)
        } else {
            description.to_string()
        };
        lines.push(format!("description: \"{}\"", escape(&description)));
    }
    if let Some(count) = result.word_count.filter(|&n| n != 0) {
        lines.push(format!("word_count: {count}"));
    }
    lines.push("---".to_string());
    format!("{}\n\n", lines.join("\n"))
}
