//! js-yaml 3.15.1 `safeDump` with default options (`indent: 2`,
//! `lineWidth: 80`, `sortKeys: false`, `noRefs: false`), ported from
//! `dumper.js`. gray-matter 4.0.3 calls it with no options.

mod style;

use std::sync::Arc;

use super::js::{iso_string, number_to_string};
use super::scalar::represent_binary;
use super::value::{YamlMap, YamlValue};
use style::write_scalar;

const BINARY_TAG: &str = "tag:yaml.org,2002:binary";

/// What `detectType` made of a value: a plain collection or string, or a typed
/// scalar that already has its text.
enum Detected<'a> {
    Seq(&'a Arc<Vec<YamlValue>>),
    Map(&'a Arc<YamlMap>),
    Str(&'a str),
    /// An implicit scalar (tag `?`): the text is final.
    Implicit(String),
    /// An explicit-tag scalar: the text still goes through `writeScalar`.
    Explicit(&'static str, String),
}

fn detect(value: &YamlValue) -> Detected<'_> {
    match value {
        YamlValue::Null => Detected::Implicit("null".to_owned()),
        YamlValue::Bool(flag) => {
            Detected::Implicit(if *flag { "true" } else { "false" }.to_owned())
        }
        YamlValue::Number(number) => Detected::Implicit(represent_number(*number)),
        YamlValue::Date(ms) => Detected::Implicit(iso_string(*ms)),
        YamlValue::Binary(bytes) => Detected::Explicit(BINARY_TAG, represent_binary(bytes)),
        YamlValue::String(text) => Detected::Str(text),
        YamlValue::Seq(items) => Detected::Seq(items),
        YamlValue::Map(map) => Detected::Map(map),
    }
}

fn represent_number(number: f64) -> String {
    if number.is_nan() {
        return ".nan".to_owned();
    }
    if number == f64::INFINITY {
        return ".inf".to_owned();
    }
    if number == f64::NEG_INFINITY {
        return "-.inf".to_owned();
    }
    if number == 0.0 && number.is_sign_negative() {
        return "-0.0".to_owned();
    }
    let text = number_to_string(number);
    if number.fract() == 0.0 {
        return text;
    }
    // `SCIENTIFIC_WITHOUT_DOT`: YAML wants `5.e-100`, JavaScript prints `5e-100`.
    let digits = text.trim_start_matches(['-', '+']);
    let mantissa_end = digits.find(|c: char| !c.is_ascii_digit());
    match mantissa_end {
        Some(at) if digits[at..].starts_with('e') && at > 0 => text.replacen('e', ".e", 1),
        _ => text,
    }
}

fn identity(value: &YamlValue) -> Option<usize> {
    match value {
        YamlValue::Seq(items) => Some(Arc::as_ptr(items) as *const u8 as usize),
        YamlValue::Map(map) => Some(Arc::as_ptr(map) as *const u8 as usize),
        _ => None,
    }
}

fn inspect_node(value: &YamlValue, objects: &mut Vec<usize>, duplicates: &mut Vec<usize>) {
    let Some(id) = identity(value) else { return };
    if let Some(index) = objects.iter().position(|seen| *seen == id) {
        if !duplicates.contains(&index) {
            duplicates.push(index);
        }
        return;
    }
    objects.push(id);
    match value {
        YamlValue::Seq(items) => items
            .iter()
            .for_each(|item| inspect_node(item, objects, duplicates)),
        YamlValue::Map(map) => map
            .iter()
            .for_each(|(_, item)| inspect_node(item, objects, duplicates)),
        _ => {}
    }
}

struct Dumper {
    dump: String,
    tag: Option<&'static str>,
    /// Identities of objects reached more than once, in discovery order.
    duplicates: Vec<usize>,
    used_duplicates: Vec<bool>,
}

fn next_line(level: usize) -> String {
    format!("\n{}", " ".repeat(2 * level))
}

impl Dumper {
    fn write_flow_sequence(&mut self, level: usize, items: &[YamlValue]) {
        let saved = self.tag;
        let mut out = String::new();
        for (index, item) in items.iter().enumerate() {
            self.write_node(level, item, false, false, false);
            if index != 0 {
                out.push_str(", ");
            }
            out.push_str(&self.dump);
        }
        self.tag = saved;
        self.dump = format!("[{out}]");
    }

    fn write_block_sequence(&mut self, level: usize, items: &[YamlValue], compact: bool) {
        let saved = self.tag;
        let mut out = String::new();
        for (index, item) in items.iter().enumerate() {
            self.write_node(level + 1, item, true, true, false);
            if !compact || index != 0 {
                out.push_str(&next_line(level));
            }
            out.push_str(if self.dump.starts_with('\n') {
                "-"
            } else {
                "- "
            });
            out.push_str(&self.dump);
        }
        self.tag = saved;
        self.dump = if out.is_empty() { "[]".to_owned() } else { out };
    }

    fn write_flow_mapping(&mut self, level: usize, map: &YamlMap) {
        let saved = self.tag;
        let mut out = String::new();
        for (index, (key, value)) in map.iter().enumerate() {
            let mut pair = String::new();
            if index != 0 {
                pair.push_str(", ");
            }
            self.write_node(
                level,
                &YamlValue::String(key.to_owned()),
                false,
                false,
                false,
            );
            if self.dump.chars().count() > 1024 {
                pair.push_str("? ");
            }
            pair.push_str(&self.dump);
            pair.push_str(": ");
            self.write_node(level, value, false, false, false);
            pair.push_str(&self.dump);
            out.push_str(&pair);
        }
        self.tag = saved;
        self.dump = format!("{{{out}}}");
    }

    fn write_block_mapping(&mut self, level: usize, map: &YamlMap, compact: bool) {
        let saved = self.tag;
        let mut out = String::new();
        for (index, (key, value)) in map.iter().enumerate() {
            let mut pair = String::new();
            if !compact || index != 0 {
                pair.push_str(&next_line(level));
            }
            self.write_node(
                level + 1,
                &YamlValue::String(key.to_owned()),
                true,
                true,
                true,
            );
            let explicit_pair =
                matches!(self.tag, Some(tag) if tag != "?") || self.dump.chars().count() > 1024;
            if explicit_pair {
                pair.push_str(if self.dump.starts_with('\n') {
                    "?"
                } else {
                    "? "
                });
            }
            pair.push_str(&self.dump);
            if explicit_pair {
                pair.push_str(&next_line(level));
            }
            self.write_node(level + 1, value, true, explicit_pair, false);
            pair.push_str(if self.dump.starts_with('\n') {
                ":"
            } else {
                ": "
            });
            pair.push_str(&self.dump);
            out.push_str(&pair);
        }
        self.tag = saved;
        self.dump = if out.is_empty() { "{}".to_owned() } else { out };
    }

    /// `writeNode`: leaves the text in `self.dump`.
    fn write_node(
        &mut self,
        level: usize,
        value: &YamlValue,
        block: bool,
        compact: bool,
        is_key: bool,
    ) {
        self.tag = None;
        let detected = detect(value);
        let mut compact = compact;
        let duplicate_index =
            identity(value).and_then(|id| self.duplicates.iter().position(|dup| *dup == id));
        let duplicate = duplicate_index.is_some();
        match &detected {
            Detected::Implicit(_) => self.tag = Some("?"),
            Detected::Explicit(tag, _) => self.tag = Some(tag),
            _ => {}
        }
        if matches!(self.tag, Some(tag) if tag != "?") || duplicate {
            compact = false;
        }

        if let Some(index) = duplicate_index {
            if self.used_duplicates[index] {
                self.dump = format!("*ref_{index}");
                return;
            }
            self.used_duplicates[index] = true;
        }
        let anchor = duplicate_index.map(|index| format!("&ref_{index}"));
        match detected {
            Detected::Map(map) => {
                if block && !map.is_empty() {
                    self.write_block_mapping(level, map, compact);
                    if let Some(anchor) = anchor {
                        self.dump = format!("{anchor}{}", self.dump);
                    }
                } else {
                    self.write_flow_mapping(level, map);
                    if let Some(anchor) = anchor {
                        self.dump = format!("{anchor} {}", self.dump);
                    }
                }
            }
            Detected::Seq(items) => {
                if block && !items.is_empty() {
                    self.write_block_sequence(level, items, compact);
                    if let Some(anchor) = anchor {
                        self.dump = format!("{anchor}{}", self.dump);
                    }
                } else {
                    self.write_flow_sequence(level, items);
                    if let Some(anchor) = anchor {
                        self.dump = format!("{anchor} {}", self.dump);
                    }
                }
            }
            Detected::Str(text) => self.dump = write_scalar(text, level, is_key),
            Detected::Implicit(text) => self.dump = text,
            Detected::Explicit(_, text) => self.dump = write_scalar(&text, level, is_key),
        }
        if let Some(tag) = self.tag.filter(|tag| *tag != "?") {
            self.dump = format!("!<{tag}> {}", self.dump);
        }
    }
}

/// `safeDump(value)`: the document text, ending in a newline.
pub fn safe_dump(value: &YamlValue) -> String {
    let mut objects = Vec::new();
    let mut duplicate_indexes = Vec::new();
    inspect_node(value, &mut objects, &mut duplicate_indexes);
    let duplicates: Vec<usize> = duplicate_indexes
        .iter()
        .map(|index| objects[*index])
        .collect();
    let mut dumper = Dumper {
        used_duplicates: vec![false; duplicates.len()],
        duplicates,
        dump: String::new(),
        tag: None,
    };
    dumper.write_node(0, value, true, true, false);
    dumper.dump + "\n"
}
