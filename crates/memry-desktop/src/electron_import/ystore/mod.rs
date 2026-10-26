//! y-leveldb 0.2.0 stores written by classic-level (`crdt-stores/<vaultDirName>/` and the legacy
//! global `crdt-store/`), read from a scratch copy.
//!
//! Key encoding (`keyEncoding` in y-leveldb): a string is `0x00`, varuint byte length, UTF-8; a
//! number is `0x01` and a big-endian u32. Keys are `[v1, doc, update, clock]` (value: the update),
//! `[v1_sv, doc]` (value: varuint clock + var bytes) and `[v1, doc, meta, key]` (value: lib0
//! `encodeAny`). The store is scanned once at open and held in memory.

pub mod lib0_any;

use std::collections::BTreeMap;
use std::path::Path;

use lib0_any::Decoder;
pub use lib0_any::Lib0Any;

use super::ImportError;
use super::profile::{ElectronProfile, vault_dir_name};
use super::scratch::ScratchDb;

/// Reserved pseudo documents and meta keys (`crdt-provider.ts`).
pub const STORE_DOC: &str = "__memry_crdt_store__";
pub const SYNC_EPOCH_KEY: &str = "syncEpoch";
pub const SNAPSHOT_WATERMARK_KEY: &str = "memry.snapshotWatermark.v1";
const WHAT: &str = "y-leveldb key";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotWatermark {
    pub applied_sequence: u64,
    pub snapshot_revision: Option<String>,
}

#[derive(Default)]
struct DocData {
    updates: BTreeMap<u32, Vec<u8>>,
    state_vector: Option<Vec<u8>>,
    meta: BTreeMap<String, Lib0Any>,
}

pub struct YStoreReader {
    docs: BTreeMap<String, DocData>,
}

enum Part {
    Str(String),
    Num(u32),
}

fn decode_key(key: &[u8]) -> Result<Vec<Part>, ImportError> {
    let mut decoder = Decoder::new(key);
    let mut parts = Vec::new();
    while decoder.has_content() {
        match decoder.read_u8()? {
            0 => parts.push(Part::Str(decoder.read_var_string()?)),
            1 => parts.push(Part::Num(decoder.read_u32_be()?)),
            _ => return Err(ImportError::parse(WHAT, 0)),
        }
    }
    Ok(parts)
}

impl YStoreReader {
    /// The per-vault store. `Ok(None)` when the vault has none.
    pub fn open(profile: &ElectronProfile, vault_uuid: &str) -> Result<Option<Self>, ImportError> {
        let dir = profile.crdt_store_root().join(vault_dir_name(vault_uuid));
        Self::open_dir(&dir)
    }

    /// The global store every build before per-vault scoping wrote.
    pub fn open_legacy(profile: &ElectronProfile) -> Result<Option<Self>, ImportError> {
        Self::open_dir(&profile.legacy_crdt_store_dir())
    }

    pub fn open_dir(dir: &Path) -> Result<Option<Self>, ImportError> {
        if !std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
            return Ok(None);
        }
        let mut db = ScratchDb::open(dir)?;
        let mut docs: BTreeMap<String, DocData> = BTreeMap::new();
        for (key, value) in db.scan_prefix(&[])? {
            let parts = decode_key(&key)?;
            match parts.as_slice() {
                [
                    Part::Str(v),
                    Part::Str(doc),
                    Part::Str(kind),
                    Part::Num(clock),
                ] if v == "v1" && kind == "update" => {
                    docs.entry(doc.clone())
                        .or_default()
                        .updates
                        .insert(*clock, value);
                }
                [
                    Part::Str(v),
                    Part::Str(doc),
                    Part::Str(kind),
                    Part::Str(name),
                ] if v == "v1" && kind == "meta" => {
                    let any = Decoder::new(&value).read_any()?;
                    docs.entry(doc.clone())
                        .or_default()
                        .meta
                        .insert(name.clone(), any);
                }
                [Part::Str(v), Part::Str(doc)] if v == "v1_sv" => {
                    let mut decoder = Decoder::new(&value);
                    decoder.read_var_uint()?;
                    let sv = decoder.read_var_bytes()?.to_vec();
                    docs.entry(doc.clone()).or_default().state_vector = Some(sv);
                }
                _ => {}
            }
        }
        Ok(Some(Self { docs }))
    }

    /// Every document with a state vector, an update or a meta entry, reserved ones included.
    pub fn doc_names(&self) -> Vec<String> {
        self.docs.keys().cloned().collect()
    }

    /// Updates ordered by clock.
    pub fn updates(&self, doc: &str) -> Vec<(u32, &[u8])> {
        self.docs
            .get(doc)
            .map(|d| d.updates.iter().map(|(c, u)| (*c, u.as_slice())).collect())
            .unwrap_or_default()
    }

    pub fn state_vector(&self, doc: &str) -> Option<&[u8]> {
        self.docs.get(doc)?.state_vector.as_deref()
    }

    pub fn meta(&self, doc: &str, key: &str) -> Option<&Lib0Any> {
        self.docs.get(doc)?.meta.get(key)
    }

    pub fn store_epoch(&self) -> Option<&str> {
        match self.meta(STORE_DOC, SYNC_EPOCH_KEY)? {
            Lib0Any::String(epoch) => Some(epoch),
            _ => None,
        }
    }

    /// `decodeSnapshotWatermark` (`packages/sync-client/src/crdt-snapshot-watermark.ts`): anything
    /// but an object with a non-negative integer `appliedSequence` and an absent or string
    /// `snapshotRevision` reads as `None`, which the caller answers with a fetch.
    pub fn watermark(&self, doc: &str) -> Option<SnapshotWatermark> {
        let Lib0Any::Object(object) = self.meta(doc, SNAPSHOT_WATERMARK_KEY)? else {
            return None;
        };
        let applied_sequence = match object.get("appliedSequence")? {
            Lib0Any::Integer(n) | Lib0Any::BigInt(n) => u64::try_from(*n).ok()?,
            // lib0 stores integers above 2^31 as floats.
            Lib0Any::Float(f) if *f >= 0.0 && f.fract() == 0.0 && *f < 2f64.powi(53) => *f as u64,
            _ => return None,
        };
        let snapshot_revision = match object.get("snapshotRevision") {
            None | Some(Lib0Any::Undefined) => None,
            Some(Lib0Any::String(s)) if s.is_empty() => None,
            Some(Lib0Any::String(s)) => Some(s.clone()),
            Some(_) => return None,
        };
        Some(SnapshotWatermark {
            applied_sequence,
            snapshot_revision,
        })
    }
}

#[cfg(test)]
mod tests;
