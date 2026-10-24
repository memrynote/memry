//! The value tree js-yaml 3.15.1 (`safeLoad`) produces and `safeDump` consumes.
//!
//! JavaScript has one `Number` type, so there is one number variant: whether a
//! value dumps as an integer or a float is decided by its value
//! (`type/int.js` and `type/float.js` predicates), exactly as in the oracle.
//! Collections sit behind `Arc` because js-yaml's dumper detects shared object
//! references (an alias `*a` loads as the same object) and writes them back as
//! `&ref_0` / `*ref_0`; `Arc::ptr_eq` is that identity.

use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum YamlValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    /// A `Date`, as milliseconds since the epoch (UTC).
    Date(i64),
    /// A Node `Buffer` (`!!binary`).
    Binary(Arc<Vec<u8>>),
    Seq(Arc<Vec<YamlValue>>),
    Map(Arc<YamlMap>),
}

impl PartialEq for YamlValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => a.to_bits() == b.to_bits() || a == b,
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Date(a), Self::Date(b)) => a == b,
            (Self::Binary(a), Self::Binary(b)) => a == b,
            (Self::Seq(a), Self::Seq(b)) => a == b,
            (Self::Map(a), Self::Map(b)) => a == b,
            _ => false,
        }
    }
}

impl YamlValue {
    pub fn seq(items: Vec<YamlValue>) -> Self {
        Self::Seq(Arc::new(items))
    }

    pub fn map(map: YamlMap) -> Self {
        Self::Map(Arc::new(map))
    }
}

/// A JavaScript plain object: string keys, iterated in `Object.keys` order.
/// Array-index keys ("0", "17", ... below 2^32 - 1) come first in ascending
/// order, every other key follows in insertion order. Replacing a key keeps its
/// position; removing and re-adding moves it to the end.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct YamlMap {
    entries: Vec<(String, YamlValue)>,
}

/// `Object.keys` treats a key as an integer index only in canonical form.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|value| *value < u64::from(u32::MAX))
        .map(|value| value as u32)
}

impl YamlMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&YamlValue> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(existing, _)| existing == key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &YamlValue)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn insert(&mut self, key: String, value: YamlValue) {
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| *existing == key)
        {
            slot.1 = value;
            return;
        }
        match array_index(&key) {
            Some(index) => {
                let at = self
                    .entries
                    .iter()
                    .position(|(existing, _)| {
                        array_index(existing).is_none_or(|other| other > index)
                    })
                    .unwrap_or(self.entries.len());
                self.entries.insert(at, (key, value));
            }
            None => self.entries.push((key, value)),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<YamlValue> {
        let at = self
            .entries
            .iter()
            .position(|(existing, _)| existing == key)?;
        Some(self.entries.remove(at).1)
    }
}
