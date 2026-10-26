//! The live file set of a LevelDB, read from its `MANIFEST-*` (`VersionEdit` records).
//!
//! Only the files the manifest names are part of the store: a log older than `log_number` and a
//! table a compaction replaced are leftovers a crash may have torn, and LevelDB ignores them.
//! Verifying them would fail a healthy store, so the integrity check covers exactly the live set.

use std::collections::BTreeSet;

use super::leveldb_log::{TornTail, read_records};

#[derive(Debug, Default)]
pub struct LiveFiles {
    /// Logs numbered below this are obsolete.
    pub log_number: u64,
    pub prev_log_number: u64,
    pub tables: BTreeSet<u64>,
    pub torn_tail: Option<TornTail>,
}

fn varint(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn skip_slice(bytes: &[u8], pos: &mut usize) -> Option<()> {
    let len = usize::try_from(varint(bytes, pos)?).ok()?;
    *pos = pos.checked_add(len).filter(|p| *p <= bytes.len())?;
    Some(())
}

fn apply(edit: &[u8], live: &mut LiveFiles) -> Option<()> {
    let mut pos = 0;
    while pos < edit.len() {
        match varint(edit, &mut pos)? {
            1 => skip_slice(edit, &mut pos)?,
            2 => live.log_number = varint(edit, &mut pos)?,
            3 | 4 => {
                varint(edit, &mut pos)?;
            }
            5 => {
                varint(edit, &mut pos)?;
                skip_slice(edit, &mut pos)?;
            }
            6 => {
                varint(edit, &mut pos)?;
                live.tables.remove(&varint(edit, &mut pos)?);
            }
            7 => {
                varint(edit, &mut pos)?;
                live.tables.insert(varint(edit, &mut pos)?);
                varint(edit, &mut pos)?;
                skip_slice(edit, &mut pos)?;
                skip_slice(edit, &mut pos)?;
            }
            9 => live.prev_log_number = varint(edit, &mut pos)?,
            _ => return None,
        }
    }
    Some(())
}

/// Reads the manifest. A checksum failure or an edit this reader cannot decode is an error
/// naming the byte offset; a torn tail is reported in the result.
pub fn live_files(manifest: &[u8]) -> Result<LiveFiles, String> {
    let records = read_records(manifest)
        .map_err(|offset| format!("manifest fails its checksum at byte {offset}"))?;
    let mut live = LiveFiles {
        torn_tail: records.torn_tail,
        ..LiveFiles::default()
    };
    for record in &records.records {
        apply(record, &mut live).ok_or_else(|| "manifest holds an undecodable edit".to_string())?;
    }
    Ok(live)
}
