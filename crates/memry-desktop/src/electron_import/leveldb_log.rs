//! Integrity check for LevelDB write-ahead logs and manifests.
//!
//! rusty-leveldb drops a log record whose checksum fails and opens the store with fewer entries,
//! so a flipped byte in `000003.log` reads as lost data, not as an error. The migration must not
//! import an incomplete store, so every `*.log` and `MANIFEST-*` of the scratch copy is verified
//! first. Format (`doc/log_format.md` in LevelDB): 32 KiB blocks of records, each a 7-byte header
//! (masked crc32c of type and payload, u16 length, u8 type) and the payload.

const BLOCK: usize = 32 * 1024;
const HEADER: usize = 7;
const MASK_DELTA: u32 = 0xa282_ead8;

fn crc32c_table() -> [u32; 256] {
    let mut table = [0_u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut crc = i as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0x82f6_3b78
            } else {
                crc >> 1
            };
        }
        *slot = crc;
    }
    table
}

fn crc32c(table: &[u32; 256], parts: &[&[u8]]) -> u32 {
    let mut crc = !0_u32;
    for byte in parts.iter().flat_map(|p| p.iter()) {
        crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

fn mask(crc: u32) -> u32 {
    crc.rotate_right(15).wrapping_add(MASK_DELTA)
}

/// Verifies every record of one log file. A torn tail passes: a header or payload cut short by
/// the end of the file, or the all-zero padding LevelDB leaves at a block end. A checksum
/// mismatch, an unknown record type or a record that overruns its block is an error naming the
/// byte offset.
pub fn verify(bytes: &[u8]) -> Result<(), usize> {
    let table = crc32c_table();
    let mut pos = 0;
    while pos < bytes.len() {
        let block_end = ((pos / BLOCK) + 1) * BLOCK;
        if block_end - pos < HEADER {
            pos = block_end;
            continue;
        }
        let Some(header) = bytes.get(pos..pos + HEADER) else {
            return Ok(());
        };
        let stored = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let len = usize::from(u16::from_le_bytes([header[4], header[5]]));
        let kind = header[6];
        if kind == 0 && len == 0 && stored == 0 {
            pos = block_end.min(pos + HEADER);
            continue;
        }
        if !(1..=4).contains(&kind) || pos + HEADER + len > block_end {
            return Err(pos);
        }
        let Some(payload) = bytes.get(pos + HEADER..pos + HEADER + len) else {
            return Ok(());
        };
        if mask(crc32c(&table, &[&[kind], payload])) != stored {
            return Err(pos);
        }
        pos += HEADER + len;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
