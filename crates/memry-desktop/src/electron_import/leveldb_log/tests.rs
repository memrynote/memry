use super::*;

fn record(kind: u8, payload: &[u8]) -> Vec<u8> {
    let crc = mask(crc32c(&[&[kind], payload]));
    let mut out = crc.to_le_bytes().to_vec();
    out.extend((payload.len() as u16).to_le_bytes());
    out.push(kind);
    out.extend(payload);
    out
}

#[test]
fn crc32c_matches_the_standard_check_value() {
    assert_eq!(crc32c(&[b"123456789"]), 0xe306_9283);
}

#[test]
fn valid_records_pass_and_every_bit_flip_in_a_record_is_caught() {
    let log = [
        record(1, b"first"),
        record(1, &[7; 100]),
        record(1, b"third record"),
    ]
    .concat();
    assert_eq!(read_records(&log).unwrap().records.len(), 3);
    for i in 0..log.len() {
        for bit in 0..8 {
            let mut bad = log.clone();
            bad[i] ^= 1 << bit;
            // Every flip is an error or a reported torn tail; none reads as a clean log.
            match read_records(&bad) {
                Err(_) => {}
                Ok(read) => assert!(read.torn_tail.is_some(), "flip at {i}:{bit} went unnoticed"),
            }
        }
    }
}

#[test]
fn a_cut_short_tail_is_reported_with_the_bytes_dropped_and_an_interior_cut_is_not_silent() {
    let log = [record(1, b"first"), record(1, b"second record")].concat();
    let first = record(1, b"first").len();
    let cut = read_records(&log[..log.len() - 3]).unwrap();
    assert_eq!(cut.records.len(), 1);
    assert_eq!(
        cut.torn_tail,
        Some(TornTail {
            offset: first,
            dropped_bytes: log.len() - 3 - first
        })
    );
    let header_only = read_records(&log[..first + 4]).unwrap();
    assert_eq!(header_only.torn_tail.unwrap().offset, first);
    assert!(read_records(&[]).unwrap().torn_tail.is_none());
    // A clean log has no torn tail; padding at a block end is not one.
    let mut padded = record(1, b"x");
    padded.resize(BLOCK, 0);
    padded.extend(record(1, b"next block"));
    let ok = read_records(&padded).unwrap();
    assert_eq!(ok.records.len(), 2);
    assert!(ok.torn_tail.is_none());
}

#[test]
fn a_length_flip_in_the_last_record_reports_every_record_it_swallowed() {
    let log = [
        record(1, b"first"),
        record(1, b"second"),
        record(1, b"third"),
    ]
    .concat();
    let second = record(1, b"first").len();
    let mut bad = log.clone();
    bad[second + 5] = 0x40;
    let read = read_records(&bad).unwrap();
    assert_eq!(read.records.len(), 1);
    assert_eq!(read.torn_tail.unwrap().offset, second);
}

#[test]
fn a_fragment_cut_short_reports_where_the_record_began() {
    let log = [record(2, b"head"), record(3, b"mid")].concat();
    let read = read_records(&log).unwrap();
    assert!(read.records.is_empty());
    assert_eq!(read.torn_tail.unwrap().offset, 0);
}

#[test]
fn an_unknown_record_type_or_overrun_is_an_error() {
    let mut bad = record(1, b"abc");
    bad[6] = 9;
    assert_eq!(read_records(&bad).unwrap_err(), 0);
    let mut overrun = record(1, b"abc");
    overrun[4] = 0xff;
    overrun[5] = 0xff;
    // Claims bytes past its block: corrupt, not torn.
    assert_eq!(read_records(&overrun).unwrap_err(), 0);
}
