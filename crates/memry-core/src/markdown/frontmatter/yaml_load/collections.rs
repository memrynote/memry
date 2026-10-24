//! The collection readers of `loader.js`: flow collections, block sequences,
//! block mappings, and `storeMappingPair` with its key stringification and
//! `<<` merge handling.

use std::collections::HashSet;
use std::sync::Arc;

use super::{
    CONTEXT_BLOCK_IN, CONTEXT_BLOCK_OUT, CONTEXT_FLOW_IN, CONTEXT_FLOW_OUT, MAX_TOTAL_MERGE_KEYS,
    Res, State, is_white_space, is_ws_or_eol,
};
use crate::markdown::frontmatter::js::{date_to_string, number_to_string};
use crate::markdown::frontmatter::scalar::{Kind, MERGE_TAG};
use crate::markdown::frontmatter::value::{YamlMap, YamlValue};

/// `String(value)` for the scalar and array values a mapping key can hold.
fn key_text(value: &YamlValue) -> String {
    match value {
        YamlValue::Null => "null".to_owned(),
        YamlValue::Bool(flag) => flag.to_string(),
        YamlValue::Number(number) => number_to_string(*number),
        YamlValue::String(text) => text.clone(),
        YamlValue::Date(ms) => date_to_string(*ms),
        YamlValue::Binary(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        YamlValue::Map(_) => "[object Object]".to_owned(),
        YamlValue::Seq(items) => items
            .iter()
            .map(|item| match item {
                YamlValue::Null => String::new(),
                other => key_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

impl State {
    fn merge_mappings(
        &mut self,
        destination: &mut YamlMap,
        source: &YamlValue,
        overridable: &mut HashSet<String>,
    ) -> Res<()> {
        // `Object.keys(source)` of a mapping, an array or a Buffer.
        let pairs: Vec<(String, YamlValue)> = match source {
            YamlValue::Map(map) => map.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
            YamlValue::Seq(items) => items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
            YamlValue::Binary(bytes) => bytes
                .iter()
                .enumerate()
                .map(|(i, b)| (i.to_string(), YamlValue::Number(f64::from(*b))))
                .collect(),
            YamlValue::Date(_) => Vec::new(),
            _ => {
                return self
                    .error("cannot merge mappings; the provided source object is unacceptable");
            }
        };
        for (key, value) in pairs {
            self.total_merge_keys += 1;
            if self.total_merge_keys > MAX_TOTAL_MERGE_KEYS {
                return self.error("merge keys exceeded maxTotalMergeKeys");
            }
            if !destination.contains_key(&key) {
                overridable.insert(key.clone());
                destination.insert(key, value);
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn store_mapping_pair(
        &mut self,
        result: &mut YamlMap,
        overridable: &mut HashSet<String>,
        key_tag: Option<&str>,
        key_node: &YamlValue,
        value_node: &YamlValue,
        start: Option<(usize, usize)>,
    ) -> Res<()> {
        if let YamlValue::Seq(items) = key_node
            && items.iter().any(|item| matches!(item, YamlValue::Seq(_)))
        {
            return self.error("nested arrays are not supported inside keys");
        }
        let key = key_text(key_node);
        if key_tag == Some(MERGE_TAG) {
            match value_node {
                YamlValue::Seq(items) => {
                    for item in items.iter() {
                        self.merge_mappings(result, item, overridable)?;
                    }
                }
                other => self.merge_mappings(result, other, overridable)?,
            }
        } else {
            if !overridable.contains(&key) && result.contains_key(&key) {
                if let Some((line, position)) = start {
                    self.line = line;
                    self.position = position;
                }
                return self.error("duplicated mapping key");
            }
            result.insert(key.clone(), value_node.clone());
            overridable.remove(&key);
        }
        Ok(())
    }

    /// Registers the anchor of a collection under construction as an empty
    /// placeholder, as the original registers the object it fills in place.
    fn anchor_placeholder(&mut self, placeholder: YamlValue) {
        if let Some(anchor) = &self.anchor {
            self.anchor_map.insert(anchor.clone(), placeholder);
        }
    }

    pub(super) fn read_flow_collection(&mut self, node_indent: i64) -> Res<bool> {
        let saved_tag = self.tag.clone();
        let saved_anchor = self.anchor.clone();
        let (terminator, is_mapping) = match self.cur() {
            0x5B => (0x5D, false),
            0x7B => (0x7D, true),
            _ => return Ok(false),
        };
        let mut seq: Vec<YamlValue> = Vec::new();
        let mut map = YamlMap::new();
        let mut overridable: HashSet<String> = HashSet::new();
        self.anchor_placeholder(if is_mapping {
            YamlValue::map(YamlMap::new())
        } else {
            YamlValue::seq(Vec::new())
        });
        let mut read_next = true;
        let mut ch = self.advance();

        while ch != 0 {
            self.skip_separation_space(true)?;
            ch = self.cur();
            if ch == terminator {
                self.position += 1;
                self.tag = saved_tag;
                self.anchor = saved_anchor.clone();
                self.kind = Some(if is_mapping {
                    Kind::Mapping
                } else {
                    Kind::Sequence
                });
                self.result = if is_mapping {
                    YamlValue::map(map)
                } else {
                    YamlValue::seq(seq)
                };
                if let Some(anchor) = saved_anchor {
                    self.anchor_map.insert(anchor, self.result.clone());
                }
                return Ok(true);
            } else if !read_next {
                return self.error("missed comma between flow collection entries");
            }

            let mut is_pair = false;
            let mut is_explicit_pair = false;
            let mut value_node = YamlValue::Null;
            if ch == 0x3F && is_ws_or_eol(self.at(self.position + 1)) {
                is_pair = true;
                is_explicit_pair = true;
                self.position += 1;
                self.skip_separation_space(true)?;
            }
            let line = self.line;
            self.compose_node(node_indent, CONTEXT_FLOW_IN, false, true)?;
            let key_tag = self.tag.clone();
            let key_node = self.result.clone();
            self.skip_separation_space(true)?;
            ch = self.cur();
            if (is_explicit_pair || self.line == line) && ch == 0x3A {
                is_pair = true;
                self.advance();
                self.skip_separation_space(true)?;
                self.compose_node(node_indent, CONTEXT_FLOW_IN, false, true)?;
                value_node = self.result.clone();
            }
            if is_mapping {
                self.store_mapping_pair(
                    &mut map,
                    &mut overridable,
                    key_tag.as_deref(),
                    &key_node,
                    &value_node,
                    None,
                )?;
            } else if is_pair {
                let mut single = YamlMap::new();
                self.store_mapping_pair(
                    &mut single,
                    &mut overridable,
                    key_tag.as_deref(),
                    &key_node,
                    &value_node,
                    None,
                )?;
                seq.push(YamlValue::map(single));
            } else {
                seq.push(key_node);
            }
            self.skip_separation_space(true)?;
            ch = self.cur();
            if ch == 0x2C {
                read_next = true;
                ch = self.advance();
            } else {
                read_next = false;
            }
        }
        self.error("unexpected end of the stream within a flow collection")
    }

    pub(super) fn read_block_sequence(&mut self, node_indent: i64) -> Res<bool> {
        let saved_tag = self.tag.clone();
        let saved_anchor = self.anchor.clone();
        let mut seq: Vec<YamlValue> = Vec::new();
        let mut detected = false;
        self.anchor_placeholder(YamlValue::seq(Vec::new()));
        let mut ch = self.cur();

        while ch != 0 {
            if ch != 0x2D {
                break;
            }
            if !is_ws_or_eol(self.at(self.position + 1)) {
                break;
            }
            detected = true;
            self.position += 1;
            if self.skip_separation_space(true)? > 0 && self.line_indent <= node_indent {
                seq.push(YamlValue::Null);
                ch = self.cur();
                continue;
            }
            let line = self.line;
            self.compose_node(node_indent, CONTEXT_BLOCK_IN, false, true)?;
            seq.push(self.result.clone());
            self.skip_separation_space(true)?;
            ch = self.cur();
            if (self.line == line || self.line_indent > node_indent) && ch != 0 {
                return self.error("bad indentation of a sequence entry");
            } else if self.line_indent < node_indent {
                break;
            }
        }
        if detected {
            self.tag = saved_tag;
            self.anchor = saved_anchor.clone();
            self.kind = Some(Kind::Sequence);
            self.result = YamlValue::seq(seq);
            if let Some(anchor) = saved_anchor {
                self.anchor_map.insert(anchor, self.result.clone());
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) fn read_block_mapping(&mut self, node_indent: i64, flow_indent: i64) -> Res<bool> {
        let saved_tag = self.tag.clone();
        let saved_anchor = self.anchor.clone();
        let mut map = YamlMap::new();
        let mut overridable: HashSet<String> = HashSet::new();
        let mut key_tag: Option<String> = None;
        let mut key_node = YamlValue::Null;
        let mut value_node = YamlValue::Null;
        let mut at_explicit_key = false;
        let mut detected = false;
        let mut allow_compact;
        self.anchor_placeholder(YamlValue::map(YamlMap::new()));
        let mut ch = self.cur();

        while ch != 0 {
            let following = self.at(self.position + 1);
            let line = self.line;
            let pos = self.position;

            if (ch == 0x3F || ch == 0x3A) && is_ws_or_eol(following) {
                if ch == 0x3F {
                    if at_explicit_key {
                        self.store_mapping_pair(
                            &mut map,
                            &mut overridable,
                            key_tag.as_deref(),
                            &key_node,
                            &YamlValue::Null,
                            None,
                        )?;
                        key_tag = None;
                        key_node = YamlValue::Null;
                        value_node = YamlValue::Null;
                    }
                    detected = true;
                    at_explicit_key = true;
                    allow_compact = true;
                } else if at_explicit_key {
                    at_explicit_key = false;
                    allow_compact = true;
                } else {
                    return self.error(
                        "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line",
                    );
                }
                self.position += 1;
                ch = following;
            } else if self.compose_node(flow_indent, CONTEXT_FLOW_OUT, false, true)? {
                if self.line == line {
                    ch = self.cur();
                    while is_white_space(ch) {
                        ch = self.advance();
                    }
                    if ch == 0x3A {
                        ch = self.advance();
                        if !is_ws_or_eol(ch) {
                            return self.error(
                                "a whitespace character is expected after the key-value separator within a block mapping",
                            );
                        }
                        if at_explicit_key {
                            self.store_mapping_pair(
                                &mut map,
                                &mut overridable,
                                key_tag.as_deref(),
                                &key_node,
                                &YamlValue::Null,
                                None,
                            )?;
                            value_node = YamlValue::Null;
                        }
                        detected = true;
                        at_explicit_key = false;
                        allow_compact = false;
                        key_tag = self.tag.clone();
                        key_node = self.result.clone();
                    } else if detected {
                        return self
                            .error("can not read an implicit mapping pair; a colon is missed");
                    } else {
                        self.tag = saved_tag;
                        self.anchor = saved_anchor;
                        return Ok(true);
                    }
                } else if detected {
                    return self.error(
                        "can not read a block mapping entry; a multiline key may not be an implicit key",
                    );
                } else {
                    self.tag = saved_tag;
                    self.anchor = saved_anchor;
                    return Ok(true);
                }
            } else {
                break;
            }

            if self.line == line || self.line_indent > node_indent {
                if self.compose_node(node_indent, CONTEXT_BLOCK_OUT, true, allow_compact)? {
                    if at_explicit_key {
                        key_node = self.result.clone();
                    } else {
                        value_node = self.result.clone();
                    }
                }
                if !at_explicit_key {
                    self.store_mapping_pair(
                        &mut map,
                        &mut overridable,
                        key_tag.as_deref(),
                        &key_node,
                        &value_node,
                        Some((line, pos)),
                    )?;
                    key_tag = None;
                    key_node = YamlValue::Null;
                    value_node = YamlValue::Null;
                }
                self.skip_separation_space(true)?;
                ch = self.cur();
            }
            if self.line_indent > node_indent && ch != 0 {
                return self.error("bad indentation of a mapping entry");
            } else if self.line_indent < node_indent {
                break;
            }
        }

        if at_explicit_key {
            self.store_mapping_pair(
                &mut map,
                &mut overridable,
                key_tag.as_deref(),
                &key_node,
                &YamlValue::Null,
                None,
            )?;
        }
        if detected {
            self.tag = saved_tag;
            self.anchor = saved_anchor.clone();
            self.kind = Some(Kind::Mapping);
            self.result = YamlValue::Map(Arc::new(map));
            if let Some(anchor) = saved_anchor {
                self.anchor_map.insert(anchor, self.result.clone());
            }
        }
        Ok(detected)
    }
}
