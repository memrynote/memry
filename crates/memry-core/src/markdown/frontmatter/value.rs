//! The value tree js-yaml 3.15.1 (`safeLoad`) produces and `safeDump` consumes.
//!
//! JavaScript has one `Number` type, so there is one number variant: whether a
//! value dumps as an integer or a float is decided by its value
//! (`type/int.js` and `type/float.js` predicates), exactly as in the oracle.
//! Collections sit behind `Arc` because js-yaml's dumper detects shared object
//! references (an alias `*a` loads as the same object) and writes them back as
//! `&ref_0` / `*ref_0`; `Arc::ptr_eq` is that identity.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Levels of nesting a frontmatter value may have in the text (the loader's
/// recursion, one frame set per level, aborts the process on a small stack
/// well before the TypeScript's `RangeError`) and, through aliases, in the
/// value. Real frontmatter nests two or three levels.
pub const MAX_YAML_DEPTH: usize = 100;

/// Deepest value the dumper writes: a loaded value is at most the text depth
/// plus one alias subtree, so this admits every loaded value with room to spare.
pub const MAX_YAML_DUMP_DEPTH: usize = 256;

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

thread_local! {
    static VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static ENTRIES_SCANNED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Named-key entries the maps on this thread have walked: every entry `Named`
/// hands out through `iter` counts, so a scan anywhere over a map's keys is
/// counted whoever writes it. For tests that bound the loader's work by steps
/// rather than by the clock.
#[doc(hidden)]
pub fn entries_scanned() -> usize {
    ENTRIES_SCANNED.with(|v| v.get())
}

/// Collections the depth walk has measured on this thread, for tests that
/// bound the loader's work by steps rather than by the clock.
#[doc(hidden)]
pub fn depth_visits() -> usize {
    VISITS.with(|v| v.get())
}

/// Heights of collections already measured, keyed by `Arc` address.
#[derive(Default)]
pub struct DepthMemo {
    heights: HashMap<usize, usize>,
    keep: Vec<YamlValue>,
}

impl YamlValue {
    /// Whether the value is more than `limit` levels deep. Iterative, so it is
    /// safe on a value of any depth, and it visits a shared collection once
    /// (an alias loads as the same `Arc`), so aliases cannot make it slow.
    pub fn deeper_than(&self, limit: usize) -> bool {
        self.deeper_than_memo(limit, &mut DepthMemo::default())
    }

    /// [`Self::deeper_than`] with heights remembered across calls, so the
    /// loader pays for each collection once however many aliases name it.
    pub fn deeper_than_memo(&self, limit: usize, memo: &mut DepthMemo) -> bool {
        fn children(value: &YamlValue) -> Vec<&YamlValue> {
            match value {
                YamlValue::Seq(items) => items.iter().collect(),
                YamlValue::Map(map) => map.iter().map(|(_, v)| v).collect(),
                _ => Vec::new(),
            }
        }
        fn id(value: &YamlValue) -> Option<usize> {
            match value {
                YamlValue::Seq(items) => Some(Arc::as_ptr(items) as *const u8 as usize),
                YamlValue::Map(map) => Some(Arc::as_ptr(map) as *const u8 as usize),
                _ => None,
            }
        }
        // Post-order with the height of every finished collection remembered.
        let heights = &mut memo.heights;
        let mut stack: Vec<(&YamlValue, Vec<&YamlValue>, usize)> = Vec::new();
        if let Some(known) = id(self).and_then(|root| heights.get(&root)) {
            return *known > limit;
        }
        if id(self).is_some() {
            stack.push((self, children(self), 0));
        }
        while let Some(top) = stack.len().checked_sub(1) {
            if let Some(child) = stack[top].1.pop() {
                let Some(child_id) = id(child) else { continue };
                if let Some(known) = heights.get(&child_id) {
                    stack[top].2 = stack[top].2.max(*known);
                } else {
                    if stack.len() >= limit {
                        return true;
                    }
                    stack.push((child, children(child), 0));
                }
                continue;
            }
            let (node, _, below) = stack.pop().expect("top exists");
            let finished = below + 1;
            if finished > limit {
                return true;
            }
            if let Some(node_id) = id(node) {
                heights.insert(node_id, finished);
                // Holding the `Arc` keeps the address from being reused.
                memo.keep.push(node.clone());
                VISITS.with(|v| v.set(v.get() + 1));
            }
            if let Some(parent) = stack.last_mut() {
                parent.2 = parent.2.max(finished);
            }
        }
        false
    }

    pub fn seq(items: Vec<YamlValue>) -> Self {
        Self::Seq(Arc::new(items))
    }

    pub fn map(map: YamlMap) -> Self {
        Self::Map(Arc::new(map))
    }
}

/// The named entries in insertion order. The only way to walk them is `iter`,
/// which counts each entry it yields (see [`entries_scanned`]).
#[derive(Debug, Clone, Default, PartialEq)]
struct Named(Vec<(String, YamlValue)>);

impl Named {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn push(&mut self, entry: (String, YamlValue)) {
        self.0.push(entry);
    }

    fn at(&self, position: usize) -> &(String, YamlValue) {
        &self.0[position]
    }

    fn value_mut(&mut self, position: usize) -> &mut YamlValue {
        &mut self.0[position].1
    }

    fn remove(&mut self, position: usize) -> (String, YamlValue) {
        self.0.remove(position)
    }

    fn iter(&self) -> impl Iterator<Item = &(String, YamlValue)> {
        self.0.iter().inspect(|_| {
            ENTRIES_SCANNED.with(|v| v.set(v.get() + 1));
        })
    }
}

/// A JavaScript plain object: string keys, iterated in `Object.keys` order.
/// Array-index keys ("0", "17", ... below 2^32 - 1) come first in ascending
/// order, every other key follows in insertion order. Replacing a key keeps its
/// position; removing and re-adding moves it to the end.
#[derive(Debug, Clone, Default)]
pub struct YamlMap {
    /// Array-index keys, ascending.
    indexed: BTreeMap<u32, (String, YamlValue)>,
    /// Every other key, in insertion order.
    named: Named,
    /// Position of each named key in `named`: an insert costs O(1), not a scan
    /// (a 2 MiB frontmatter holds hundreds of thousands of keys).
    lookup: HashMap<String, usize>,
}

impl PartialEq for YamlMap {
    fn eq(&self, other: &Self) -> bool {
        self.indexed == other.indexed && self.named == other.named
    }
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
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, key: &str) -> Option<&YamlValue> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index).map(|(_, value)| value),
            None => self.named_position(key).map(|at| &self.named.at(at).1),
        }
    }

    /// Position of a named key: one hash probe, not a scan of `named`.
    fn named_position(&self, key: &str) -> Option<usize> {
        self.lookup.get(key).copied()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &YamlValue)> {
        self.indexed
            .values()
            .chain(self.named.iter())
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn insert(&mut self, key: String, value: YamlValue) {
        match array_index(&key) {
            Some(index) => {
                self.indexed.insert(index, (key, value));
            }
            None => match self.named_position(&key) {
                Some(at) => *self.named.value_mut(at) = value,
                None => {
                    self.lookup.insert(key.clone(), self.named.len());
                    self.named.push((key, value));
                }
            },
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<YamlValue> {
        if let Some(index) = array_index(key) {
            return self.indexed.remove(&index).map(|(_, value)| value);
        }
        let at = self.lookup.remove(key)?;
        let removed = self.named.remove(at).1;
        for (position, (name, _)) in self.named.iter().enumerate().skip(at) {
            self.lookup.insert(name.clone(), position);
        }
        Some(removed)
    }
}
