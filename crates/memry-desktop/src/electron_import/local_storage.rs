//! Chromium `Local Storage/leveldb`: the renderer's `localStorage`.
//!
//! Entry layout: key `_<origin>` + `0x00` + format byte + key text, value = format byte + text,
//! where format `0x01` is Latin-1 and `0x00` is UTF-16LE. The packaged renderer loads through
//! `loadFile`, so its origin is `file://`.

use std::collections::BTreeMap;

use super::ImportError;
use super::profile::ElectronProfile;
use super::scratch::{Scratch, ScratchDb};

pub const PACKAGED_ORIGIN: &str = "file://";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalStorageSnapshot {
    pub entries: BTreeMap<String, String>,
    /// Entries of the origin whose key or value could not be decoded.
    pub skipped: usize,
}

impl LocalStorageSnapshot {
    /// `Ok(None)` when the profile has no localStorage store.
    pub fn read(
        profile: &ElectronProfile,
        origin: &str,
        scratch: &Scratch,
    ) -> Result<Option<Self>, ImportError> {
        let dir = profile.local_storage_dir();
        if !profile.has_local_storage {
            return Ok(None);
        }
        let mut db = ScratchDb::open(scratch, &dir)?;
        let mut prefix = format!("_{origin}").into_bytes();
        prefix.push(0);
        let mut snapshot = Self::default();
        for (key, value) in db.scan_prefix(&prefix)? {
            match (decode(&key[prefix.len()..]), decode(&value)) {
                (Some(k), Some(v)) => {
                    snapshot.entries.insert(k, v);
                }
                _ => snapshot.skipped += 1,
            }
        }
        Ok(Some(snapshot))
    }
}

/// One format byte, then Latin-1 or UTF-16LE text.
fn decode(bytes: &[u8]) -> Option<String> {
    let (format, data) = bytes.split_first()?;
    match format {
        0x01 => Some(data.iter().map(|b| char::from(*b)).collect()),
        0x00 => {
            let (units, rest) = data.as_chunks::<2>();
            if !rest.is_empty() {
                return None;
            }
            char::decode_utf16(units.iter().map(|u| u16::from_le_bytes(*u)))
                .collect::<Result<String, _>>()
                .ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
