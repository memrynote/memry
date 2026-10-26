//! Integrity check and record reader for LevelDB write-ahead logs and manifests.
//!
//! rusty-leveldb drops a log record whose checksum fails and opens the store with fewer entries,
//! so a flipped byte in `000003.log` reads as lost data, not as an error. The migration must not
//! import an incomplete store, so the files of the scratch copy are verified before it is opened.
//! Format (`doc/log_format.md` in LevelDB): 32 KiB blocks of records, each a 7-byte header
//! (masked crc32c of type and payload, u16 length, u8 type) and the payload. Types: 1 full,
//! 2 first, 3 middle, 4 last fragment of a record; a zero header is block padding.

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

pub(super) fn crc32c(parts: &[&[u8]]) -> u32 {
    let table = crc32c_table();
    let mut crc = !0_u32;
    for byte in parts.iter().flat_map(|p| p.iter()) {
        crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

pub(super) fn mask(crc: u32) -> u32 {
    crc.rotate_right(15).wrapping_add(MASK_DELTA)
}

/// A record the end of the file cut short: LevelDB drops it and everything after it. A real
/// crash leaves one at the tail; a corrupt length field in the last block looks the same and
/// loses every later record, so the caller reports it instead of hiding it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TornTail {
    pub offset: usize,
    pub dropped_bytes: usize,
}

/// The reassembled records of a file and its torn tail, if any.
#[derive(Debug, Default)]
pub struct Records {
    pub records: Vec<Vec<u8>>,
    pub torn_tail: Option<TornTail>,
}

/// Reads and verifies every record. A checksum mismatch, an unknown record type, a record that
/// overruns its block or a broken fragment sequence is an error carrying the byte offset. A
/// header or payload cut short by the end of the file is a torn tail, not an error.
pub fn read_records(bytes: &[u8]) -> Result<Records, usize> {
    let mut out = Records::default();
    let mut pos = 0;
    let mut fragment: Option<(usize, Vec<u8>)> = None;
    let torn = |at: usize| TornTail {
        offset: at,
        dropped_bytes: bytes.len() - at,
    };
    while pos < bytes.len() {
        let block_end = ((pos / BLOCK) + 1) * BLOCK;
        if block_end - pos < HEADER {
            pos = block_end;
            continue;
        }
        let Some(header) = bytes.get(pos..pos + HEADER) else {
            out.torn_tail = Some(torn(fragment.as_ref().map_or(pos, |(start, _)| *start)));
            return Ok(out);
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
            out.torn_tail = Some(torn(fragment.as_ref().map_or(pos, |(start, _)| *start)));
            return Ok(out);
        };
        if mask(crc32c(&[&[kind], payload])) != stored {
            return Err(pos);
        }
        match (kind, fragment.take()) {
            (1, None) => out.records.push(payload.to_vec()),
            (2, None) => fragment = Some((pos, payload.to_vec())),
            (3, Some((start, mut data))) => {
                data.extend_from_slice(payload);
                fragment = Some((start, data));
            }
            (4, Some((_, mut data))) => {
                data.extend_from_slice(payload);
                out.records.push(data);
            }
            _ => return Err(pos),
        }
        pos += HEADER + len;
    }
    if let Some((start, _)) = fragment {
        out.torn_tail = Some(torn(start));
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
