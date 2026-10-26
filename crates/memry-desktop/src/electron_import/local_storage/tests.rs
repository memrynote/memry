use super::*;
use crate::electron_import::tests::macos_fixture;

#[test]
fn reads_the_renderer_entries_written_by_chromium() {
    let f = macos_fixture("new");
    let snapshot = LocalStorageSnapshot::read(&f.profile, PACKAGED_ORIGIN)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.skipped, 0);
    assert_eq!(
        snapshot.entries["memry_tab_state:/Users/fixture/vault"],
        r#"{"tabs":["a","b"]}"#
    );
    assert_eq!(snapshot.entries["memry.theme"], "dark");
    assert_eq!(snapshot.entries["memry.unicode"], "日本語 ✓ fixture");
    assert_eq!(snapshot.entries["anahtar-ğ"], "değer");
    assert_eq!(snapshot.entries.len(), 4);
}

#[test]
fn another_origin_sees_nothing() {
    let f = macos_fixture("new");
    let snapshot = LocalStorageSnapshot::read(&f.profile, "http://localhost:5174")
        .unwrap()
        .unwrap();
    assert!(snapshot.entries.is_empty());
}

#[test]
fn no_store_is_none() {
    let mut f = macos_fixture("new");
    f.profile.has_local_storage = false;
    assert!(
        LocalStorageSnapshot::read(&f.profile, PACKAGED_ORIGIN)
            .unwrap()
            .is_none()
    );
}

#[test]
fn decode_formats() {
    assert_eq!(decode(&[1, b'a', 0xe9]).as_deref(), Some("aé"));
    assert_eq!(decode(&[0, b'a', 0, 0x2f, 0x26]).as_deref(), Some("a☯"));
    assert_eq!(decode(&[0, b'a']), None);
    assert_eq!(decode(&[0, 0x00, 0xd8]), None);
    assert_eq!(decode(&[7, 1]), None);
    assert_eq!(decode(&[]), None);
}
