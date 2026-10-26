use super::*;

fn record(kind: u8, payload: &[u8]) -> Vec<u8> {
    let table = crc32c_table();
    let crc = mask(crc32c(&table, &[&[kind], payload]));
    let mut out = crc.to_le_bytes().to_vec();
    out.extend((payload.len() as u16).to_le_bytes());
    out.push(kind);
    out.extend(payload);
    out
}

#[test]
fn crc32c_matches_the_standard_check_value() {
    assert_eq!(crc32c(&crc32c_table(), &[b"123456789"]), 0xe306_9283);
}

#[test]
fn valid_records_pass_and_every_bit_flip_in_a_record_is_caught() {
    let log = [
        record(1, b"first"),
        record(1, &[7; 100]),
        record(1, b"third record"),
    ]
    .concat();
    verify(&log).unwrap();
    let starts = [
        0,
        record(1, b"first").len(),
        record(1, b"first").len() + 107,
    ];
    for i in 0..log.len() {
        for bit in 0..8 {
            let mut bad = log.clone();
            bad[i] ^= 1 << bit;
            // A length field flipped to claim bytes past the end of the file is
            // indistinguishable from a torn tail and is tolerated by design.
            let overruns = starts.iter().any(|s| {
                (s + 4..s + 6).contains(&i)
                    && s + 7 + usize::from(u16::from_le_bytes([bad[s + 4], bad[s + 5]])) > bad.len()
            });
            if !overruns {
                assert!(verify(&bad).is_err(), "flip at {i}:{bit} went unnoticed");
            }
        }
    }
}

#[test]
fn a_torn_tail_is_tolerated_but_an_interior_cut_is_not() {
    let log = [record(1, b"first"), record(1, b"second record")].concat();
    verify(&log[..log.len() - 3]).unwrap();
    verify(&log[..record(1, b"first").len() + 4]).unwrap();
    verify(&[]).unwrap();
    // Zero padding at a block end.
    let mut padded = record(1, b"x");
    padded.resize(BLOCK, 0);
    padded.extend(record(1, b"next block"));
    verify(&padded).unwrap();
}

#[test]
fn an_unknown_record_type_or_overrun_is_an_error() {
    let mut bad = record(1, b"abc");
    bad[6] = 9;
    assert_eq!(verify(&bad), Err(0));
    let mut overrun = record(1, b"abc");
    overrun[4] = 0xff;
    overrun[5] = 0xff;
    assert_eq!(verify(&overrun), Err(0));
}
