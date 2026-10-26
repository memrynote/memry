//! Integrity check for LevelDB table files (`*.ldb`, `*.sst`).
//!
//! rusty-leveldb's table iterator skips a block whose read fails (`Err(_) => self.advance()`)
//! and never reads `paranoid_checks`, so a flipped byte in a compacted store reads as missing
//! rows. Every block reachable from the footer is therefore checksummed before the store is
//! opened. Layout (`doc/table_format.md`): data blocks, a meta block with the filter, a
//! metaindex block, an index block and a 48-byte footer ending in an 8-byte magic. Every block is
//! followed by a type byte and a masked crc32c of block and type.

use super::leveldb_log::{crc32c, mask};

const FOOTER: usize = 48;
const MAGIC: u64 = 0xdb47_7524_8b80_fb57;
const TRAILER: usize = 5;

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

#[derive(Clone, Copy)]
struct Handle {
    offset: usize,
    size: usize,
}

fn handle(bytes: &[u8], pos: &mut usize) -> Option<Handle> {
    Some(Handle {
        offset: usize::try_from(varint(bytes, pos)?).ok()?,
        size: usize::try_from(varint(bytes, pos)?).ok()?,
    })
}

/// Checks the block's crc and returns its contents (without trailer).
fn block(file: &[u8], h: Handle) -> Result<&[u8], String> {
    let end = h
        .offset
        .checked_add(h.size)
        .and_then(|e| e.checked_add(TRAILER))
        .filter(|e| *e <= file.len() - FOOTER)
        .ok_or_else(|| format!("block at {} runs past the table", h.offset))?;
    let data = &file[h.offset..h.offset + h.size];
    let kind = file[h.offset + h.size];
    let stored = u32::from_le_bytes(file[end - 4..end].try_into().expect("4 bytes"));
    if mask(crc32c(&[data, &[kind]])) != stored {
        return Err(format!("block at {} fails its checksum", h.offset));
    }
    Ok(data)
}

/// The values of a block's entries: for the index and metaindex blocks each value is a handle.
/// A compressed block cannot be parsed without decompressing, and index blocks are never
/// compressed by LevelDB writers, so a compressed one is rejected.
fn values(file: &[u8], h: Handle) -> Result<Vec<Handle>, String> {
    let data = block(file, h)?;
    if file[h.offset + h.size] != 0 {
        return Err(format!("index block at {} is compressed", h.offset));
    }
    let bad = || format!("index block at {} is malformed", h.offset);
    let restarts = u32::from_le_bytes(
        data.get(data.len().wrapping_sub(4)..)
            .ok_or_else(bad)?
            .try_into()
            .map_err(|_| bad())?,
    ) as usize;
    let end = data
        .len()
        .checked_sub(4 + restarts.checked_mul(4).ok_or_else(bad)?)
        .ok_or_else(bad)?;
    let mut pos = 0;
    let mut out = Vec::new();
    while pos < end {
        varint(data, &mut pos).ok_or_else(bad)?;
        let unshared = varint(data, &mut pos).ok_or_else(bad)?;
        let vlen = varint(data, &mut pos).ok_or_else(bad)?;
        pos = pos
            .checked_add(usize::try_from(unshared).map_err(|_| bad())?)
            .ok_or_else(bad)?;
        let vend = pos
            .checked_add(usize::try_from(vlen).map_err(|_| bad())?)
            .filter(|e| *e <= end)
            .ok_or_else(bad)?;
        let mut vpos = pos;
        out.push(handle(&data[..vend], &mut vpos).ok_or_else(bad)?);
        pos = vend;
    }
    Ok(out)
}

/// Verifies the footer, the index and metaindex blocks and every block they point at.
pub fn verify(file: &[u8]) -> Result<(), String> {
    if file.len() < FOOTER {
        return Err("table is shorter than its footer".into());
    }
    let footer = &file[file.len() - FOOTER..];
    let magic = u64::from_le_bytes(footer[FOOTER - 8..].try_into().expect("8 bytes"));
    if magic != MAGIC {
        return Err("table footer has the wrong magic".into());
    }
    let mut pos = 0;
    let bad = || "table footer is malformed".to_string();
    let metaindex = handle(footer, &mut pos).ok_or_else(bad)?;
    let index = handle(footer, &mut pos).ok_or_else(bad)?;
    for meta in values(file, metaindex)? {
        block(file, meta)?;
    }
    for data in values(file, index)? {
        block(file, data)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
