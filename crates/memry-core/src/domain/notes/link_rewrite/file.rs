//! [`rewrite_file`]: the inbound link repair over a whole vault file, its frontmatter read as
//! YAML. Electron rewrites the file's raw text, frontmatter included, so a title YAML must
//! quote otherwise (`'` in a single-quoted value, `\` in a double-quoted one) breaks the block
//! or changes what it says. Here the block's raw rewrite, Electron's bytes, is kept when it
//! reads back as its values rewritten one by one. Otherwise every key whose value changed is
//! written again by the frontmatter editor ([`edit_frontmatter_block`]), as YAML spells it, and
//! only the keys and lines that name no renamed note keep their bytes; a block it cannot edit
//! key by key keeps its links.
//!
//! Untrusted input: a value is walked once per collection, however many aliases share it. Its
//! depth is the loader's to bound (`MAX_YAML_DEPTH` in the text, one alias subtree more in the
//! value), so the walk's recursion is too.

use std::collections::HashMap;
use std::sync::Arc;

use crate::api::errors::StorageError;
use crate::markdown::frontmatter::{
    YamlMap, YamlValue, deep_strict_equal, edit_frontmatter_block, parse_markdown_note,
    split_frontmatter_block,
};

use super::{LinkNames, Rule, scan, text_step};

/// What [`rewrite_file`] came to.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FileRewrite {
    /// The new text, or `None` when no link changed.
    pub text: Option<String>,
    /// Links left as they were, because the new name would spell another link.
    pub skipped: usize,
    /// The frontmatter names the note and was kept: its lines cannot be edited key by key.
    pub frontmatter_kept: bool,
}

/// [`super::rewrite_text`] over a whole file: its body as text, its frontmatter as YAML (see
/// the module comment). A frontmatter that does not parse is kept as it is.
pub fn rewrite_file(
    text: &str,
    note_id: &str,
    from: &LinkNames,
    to: &LinkNames,
    other_claims: impl Fn(&str) -> Result<bool, StorageError>,
) -> Result<FileRewrite, StorageError> {
    let mut out = FileRewrite::default();
    let Some(rule) = Rule::of(note_id, from, to) else {
        return Ok(out);
    };
    let split = split_frontmatter_block(text);
    let body = scan(split.body, &rule, &other_claims, &mut out.skipped)?;
    let block = match split.block {
        Some(block) => rewrite_block(block, &rule, &other_claims, &mut out)?,
        None => None,
    };
    if block.is_some() || body.is_some() {
        let block = block.as_deref().or(split.block).unwrap_or_default();
        out.text = Some(format!("{block}{}", body.as_deref().unwrap_or(split.body)));
    }
    Ok(out)
}

fn rewrite_block(
    block: &str,
    rule: &Rule<'_>,
    other_claims: &impl Fn(&str) -> Result<bool, StorageError>,
    out: &mut FileRewrite,
) -> Result<Option<String>, StorageError> {
    let mut raw_skipped = 0;
    let Some(raw) = scan(block, rule, other_claims, &mut raw_skipped)? else {
        out.skipped += raw_skipped;
        return Ok(None);
    };
    let Ok(parsed) = parse_markdown_note(block) else {
        return Ok(None);
    };
    let mut values = Values {
        rule,
        other_claims,
        skipped: 0,
        seen: HashMap::new(),
    };
    let next = values.value(&parsed.frontmatter)?;
    let wanted = next.as_ref().unwrap_or(&parsed.frontmatter);
    if parse_markdown_note(&raw).is_ok_and(|read| deep_strict_equal(&read.frontmatter, wanted)) {
        out.skipped += raw_skipped;
        return Ok(Some(raw));
    }
    out.skipped += values.skipped;
    let (YamlValue::Map(reading), Some(YamlValue::Map(next))) = (&parsed.frontmatter, next) else {
        out.frontmatter_kept = true;
        return Ok(None);
    };
    match edit_frontmatter_block(block, reading, &next) {
        Ok(Some(edited)) => Ok(Some(edited)),
        Ok(None) | Err(_) => {
            out.frontmatter_kept = true;
            Ok(None)
        }
    }
}

/// The frontmatter's strings with their links re-pointed, each collection walked once.
struct Values<'r, 'n, F> {
    rule: &'r Rule<'n>,
    other_claims: &'r F,
    skipped: usize,
    /// What each collection already walked became, by address: an alias is the same `Arc`.
    seen: HashMap<usize, Option<YamlValue>>,
}

impl<F: Fn(&str) -> Result<bool, StorageError>> Values<'_, '_, F> {
    /// `value` with its links re-pointed, or `None` when none changed.
    fn value(&mut self, value: &YamlValue) -> Result<Option<YamlValue>, StorageError> {
        text_step(1);
        let key = match value {
            YamlValue::String(text) => {
                return Ok(scan(text, self.rule, self.other_claims, &mut self.skipped)?
                    .map(YamlValue::String));
            }
            YamlValue::Seq(items) => Arc::as_ptr(items) as usize,
            YamlValue::Map(map) => Arc::as_ptr(map) as usize,
            _ => return Ok(None),
        };
        if let Some(done) = self.seen.get(&key) {
            return Ok(done.clone());
        }
        let next = match value {
            YamlValue::Seq(items) => {
                let mut next: Option<Vec<YamlValue>> = None;
                for (at, item) in items.iter().enumerate() {
                    if let Some(item) = self.value(item)? {
                        next.get_or_insert_with(|| items.to_vec())[at] = item;
                    }
                }
                next.map(|items| YamlValue::Seq(Arc::new(items)))
            }
            YamlValue::Map(map) => {
                let mut next: Option<YamlMap> = None;
                for (name, item) in map.iter() {
                    if let Some(item) = self.value(item)? {
                        next.get_or_insert_with(|| (**map).clone())
                            .insert(name.to_owned(), item);
                    }
                }
                next.map(YamlValue::map)
            }
            _ => None,
        };
        self.seen.insert(key, next.clone());
        Ok(next)
    }
}
