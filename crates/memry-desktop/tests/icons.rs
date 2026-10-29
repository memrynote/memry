//! `vault::icons` on a real temp vault: the one writer of `.memry/icons/`, which sanitizes every
//! SVG, refuses names a synced record could use to leave the folder, and never recreates a
//! vault that is away.

use std::fs;
use std::path::Path;

use memry_desktop::vault::icons::{IconError, icon_exists, icon_path, remove_icon, write_icon};
use memry_desktop::vault::svg::MAX_SVG_BYTES;

fn vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("memry-icons-")
        .tempdir()
        .expect("temp dir");
    fs::create_dir(dir.path().join(".memry")).expect(".memry");
    dir
}

fn icon(vault: &Path, name: &str) -> Vec<u8> {
    fs::read(vault.join(".memry").join("icons").join(name)).expect("icon file")
}

#[test]
fn an_svg_is_written_sanitized_into_the_icons_folder() {
    let dir = vault();
    let path = write_icon(
        dir.path(),
        "a1_B-2",
        "svg",
        br#"<svg onload="x()"><script>alert(1)</script><rect/></svg>"#,
    )
    .expect("write");
    assert_eq!(path, dir.path().join(".memry/icons/a1_B-2.svg"));
    assert_eq!(icon(dir.path(), "a1_B-2.svg"), b"<svg><rect/></svg>");

    write_icon(
        dir.path(),
        "upper",
        "SVG",
        br#"<svg><a href="x"><g/></a></svg>"#,
    )
    .expect("write");
    assert_eq!(icon(dir.path(), "upper.SVG"), b"<svg><g/></svg>");
}

#[test]
fn raster_bytes_are_written_as_they_are_and_replace_the_last_ones() {
    let dir = vault();
    write_icon(dir.path(), "p", "png", b"\x89PNG one").expect("write");
    write_icon(dir.path(), "p", "png", b"\x89PNG two").expect("write");
    assert_eq!(icon(dir.path(), "p.png"), b"\x89PNG two");
    let leftovers: Vec<_> = fs::read_dir(dir.path().join(".memry/icons"))
        .expect("list")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(leftovers, ["p.png"]);
}

#[test]
fn an_svg_with_nothing_usable_writes_nothing_and_keeps_the_last_icon() {
    let dir = vault();
    write_icon(dir.path(), "i", "svg", b"<svg><rect/></svg>").expect("write");
    let err = write_icon(dir.path(), "i", "svg", b"<html><script>x</script></html>")
        .expect_err("not an svg");
    assert!(
        matches!(err, IconError::UnusableSvg(ref id) if id == "i"),
        "{err:?}"
    );
    assert_eq!(icon(dir.path(), "i.svg"), b"<svg><rect/></svg>");

    let err = write_icon(dir.path(), "j", "svg", b"<foreignObject/>").expect_err("not an svg");
    assert!(matches!(err, IconError::UnusableSvg(_)), "{err:?}");
    assert!(!icon_exists(dir.path(), "j", "svg"));
}

#[test]
fn an_svg_over_the_limit_is_refused_by_size_and_keeps_the_last_icon() {
    let dir = vault();
    write_icon(dir.path(), "big", "svg", b"<svg><rect/></svg>").expect("write");
    let over = format!("<svg>{}</svg>", " ".repeat(MAX_SVG_BYTES));
    let err = write_icon(dir.path(), "big", "svg", over.as_bytes()).expect_err("over the limit");
    assert!(
        matches!(err, IconError::TooLarge { ref id, bytes } if id == "big" && bytes == over.len()),
        "{err:?}"
    );
    assert_eq!(icon(dir.path(), "big.svg"), b"<svg><rect/></svg>");

    // Under the limit as bytes, over it as text: each malformed byte decodes to U+FFFD.
    let mut malformed = b"<svg>".to_vec();
    malformed.resize(MAX_SVG_BYTES / 2, 0xff);
    let err = write_icon(dir.path(), "big", "svg", &malformed).expect_err("over the limit");
    assert!(matches!(err, IconError::TooLarge { .. }), "{err:?}");
}

/// A link planted at an icon's path is replaced, never written through: the file it points
/// at, outside the vault, keeps its bytes.
#[cfg(unix)]
#[test]
fn a_link_at_the_icon_path_is_replaced_and_its_target_is_untouched() {
    let dir = vault();
    let outside = tempfile::NamedTempFile::new().expect("outside file");
    fs::write(outside.path(), b"not the vault's").expect("outside bytes");
    fs::create_dir(dir.path().join(".memry/icons")).expect("icons");
    let planted = dir.path().join(".memry/icons/p.png");
    std::os::unix::fs::symlink(outside.path(), &planted).expect("plant the link");

    write_icon(dir.path(), "p", "png", b"\x89PNG new").expect("write");
    assert_eq!(
        fs::read(outside.path()).expect("outside"),
        b"not the vault's"
    );
    let meta = fs::symlink_metadata(&planted).expect("icon");
    assert!(meta.file_type().is_file(), "{meta:?}");
    assert_eq!(icon(dir.path(), "p.png"), b"\x89PNG new");
}

#[test]
fn a_name_that_could_leave_the_folder_is_refused_everywhere() {
    let dir = vault();
    let bad = [
        ("..", "svg"),
        ("../x", "png"),
        ("a/b", "png"),
        ("a\\b", "png"),
        ("a.b", "png"),
        ("", "png"),
        ("ok", ""),
        ("ok", "s/g"),
        ("ok", "p.ng"),
        ("ok", "png\0"),
        ("caf\u{e9}", "png"),
    ];
    for (id, ext) in bad {
        assert!(
            matches!(
                icon_path(dir.path(), id, ext),
                Err(IconError::InvalidName { .. })
            ),
            "{id:?}.{ext:?}"
        );
        assert!(
            matches!(
                write_icon(dir.path(), id, ext, b"x"),
                Err(IconError::InvalidName { .. })
            ),
            "{id:?}.{ext:?}"
        );
        assert!(matches!(
            remove_icon(dir.path(), id, ext),
            Err(IconError::InvalidName { .. })
        ));
        assert!(!icon_exists(dir.path(), id, ext));
    }
    assert!(!dir.path().join(".memry/icons").exists());
    assert!(!dir.path().join("x").exists());
}

#[test]
fn a_vault_that_is_away_is_not_recreated() {
    let parent = tempfile::Builder::new()
        .prefix("memry-icons-away-")
        .tempdir()
        .expect("temp dir");
    let away = parent.path().join("vault");
    let err = write_icon(&away, "i", "png", b"x").expect_err("no vault");
    assert!(
        matches!(err, IconError::Io(ref e) if e.kind() == std::io::ErrorKind::NotFound),
        "{err:?}"
    );
    assert!(!away.exists());
}

#[test]
fn removing_an_icon_is_idempotent() {
    let dir = vault();
    write_icon(dir.path(), "r", "png", b"x").expect("write");
    assert!(icon_exists(dir.path(), "r", "png"));
    remove_icon(dir.path(), "r", "png").expect("remove");
    assert!(!icon_exists(dir.path(), "r", "png"));
    remove_icon(dir.path(), "r", "png").expect("remove again");
}
