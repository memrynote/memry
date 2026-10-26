use super::*;

#[test]
fn var_uint_and_var_int() {
    assert_eq!(Decoder::new(&[0x7f]).read_var_uint().unwrap(), 127);
    assert_eq!(Decoder::new(&[0x80, 0x01]).read_var_uint().unwrap(), 128);
    assert_eq!(Decoder::new(&[0x2a]).read_var_int().unwrap(), 42);
    assert_eq!(Decoder::new(&[0x6a]).read_var_int().unwrap(), -42);
    // 300 = 0b1_0010_1100: low 6 bits 101100 with continuation, then 0b100.
    assert_eq!(Decoder::new(&[0xac, 0x04]).read_var_int().unwrap(), 300);
    assert_eq!(Decoder::new(&[0xec, 0x04]).read_var_int().unwrap(), -300);
}

#[test]
fn any_values() {
    let mut obj = vec![118, 2];
    obj.extend([1, b'a', 125, 5]);
    obj.extend([1, b'b', 119, 2, b'h', b'i']);
    let mut d = Decoder::new(&obj);
    let Lib0Any::Object(map) = d.read_any().unwrap() else {
        panic!()
    };
    assert_eq!(map["a"], Lib0Any::Integer(5));
    assert_eq!(map["b"], Lib0Any::String("hi".into()));
    assert!(!d.has_content());
    assert_eq!(Decoder::new(&[127]).read_any().unwrap(), Lib0Any::Undefined);
    assert_eq!(Decoder::new(&[126]).read_any().unwrap(), Lib0Any::Null);
    assert_eq!(
        Decoder::new(&[120]).read_any().unwrap(),
        Lib0Any::Bool(true)
    );
    assert_eq!(
        Decoder::new(&[121]).read_any().unwrap(),
        Lib0Any::Bool(false)
    );
    let mut f64v = vec![123];
    f64v.extend(1.5_f64.to_be_bytes());
    assert_eq!(Decoder::new(&f64v).read_any().unwrap(), Lib0Any::Float(1.5));
    let mut f32v = vec![124];
    f32v.extend(0.25_f32.to_be_bytes());
    assert_eq!(
        Decoder::new(&f32v).read_any().unwrap(),
        Lib0Any::Float(0.25)
    );
    let mut big = vec![122];
    big.extend((-9_i64).to_be_bytes());
    assert_eq!(Decoder::new(&big).read_any().unwrap(), Lib0Any::BigInt(-9));
    assert_eq!(
        Decoder::new(&[117, 2, 120, 126]).read_any().unwrap(),
        Lib0Any::Array(vec![Lib0Any::Bool(true), Lib0Any::Null])
    );
    assert_eq!(
        Decoder::new(&[116, 2, 9, 8]).read_any().unwrap(),
        Lib0Any::Bytes(vec![9, 8])
    );
}

#[test]
fn truncated_or_unknown_input_is_a_parse_error() {
    for bytes in [
        &[][..],
        &[125],
        &[119, 5, b'a'],
        &[118, 1, 1],
        &[123, 0, 0],
        &[116, 9, 1],
        &[10],
        &[0x80],
    ] {
        let result = Decoder::new(bytes).read_any();
        assert!(
            matches!(result, Err(ImportError::Parse { .. })),
            "{bytes:?}"
        );
    }
    assert!(Decoder::new(&[0x80; 12]).read_var_uint().is_err());
    let nested: Vec<u8> = std::iter::repeat_n([117, 1], 200)
        .flatten()
        .chain([126])
        .collect();
    assert!(Decoder::new(&nested).read_any().is_err());
}
