//! Types of the writing tools markdown (`writing-tools/markdown.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const WRITING_FRONTMATTER_KEY: &str = "writing";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WritingMarkerKind {
    Alt,
    Ghost,
}

/// One end of a marked range. `key` pairs the ends: the alternative id, or a
/// per-parse ghost key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingMarker {
    pub kind: WritingMarkerKind,
    pub key: String,
    pub open: bool,
}

/// Sentinel character -> the marker it stands for, ordered by character.
pub type WritingSentinelMap = BTreeMap<char, WritingMarker>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingFrontmatterVersion {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingFrontmatterAlternative {
    /// Present only while the body shows one of the versions instead of the original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    pub versions: Vec<WritingFrontmatterVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingFrontmatterOverflowItem {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `alternatives` keeps the order of a JavaScript object: array-index keys
/// ascending, then the rest in insertion order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WritingFrontmatter {
    #[serde(with = "ordered_map")]
    pub alternatives: Vec<(String, WritingFrontmatterAlternative)>,
    pub overflow: Vec<WritingFrontmatterOverflowItem>,
}

mod ordered_map {
    use std::fmt;

    use serde::de::{MapAccess, Visitor};
    use serde::ser::SerializeMap;
    use serde::{Deserializer, Serializer};

    use super::WritingFrontmatterAlternative;

    type Entries = Vec<(String, WritingFrontmatterAlternative)>;

    pub fn serialize<S: Serializer>(entries: &Entries, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(entries.len()))?;
        for (key, value) in entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Entries, D::Error> {
        struct Pairs;
        impl<'de> Visitor<'de> for Pairs {
            type Value = Entries;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a map of alternatives")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Entries, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    out.push(entry);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_map(Pairs)
    }
}
