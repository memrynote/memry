use super::*;

/// A file's image embeds reach its note as Electron's main process parses them: resolved
/// relative to the note, here through the vault's image rows. The body names no folder of this
/// device, which would reach every device the note syncs to.
#[test]
fn a_fed_image_embed_is_written_relative_to_its_note() {
    let f = fixture();
    f.write("img/photo.png", "x");
    let image = RowStat {
        file_type: FileType::Image,
        size: 1,
        content_hash: None,
        file_hash: None,
    };
    f.rows
        .record_write(f.session(), "image", "img/photo.png", image)
        .unwrap();
    f.write("notes/a.md", "![[photo.png]]\n");
    assert_eq!(f.added("notes/a.md"), Step::Done);
    let body = f.body(&only_note(&f, "notes/a.md"));
    assert_eq!(body, "![photo.png](../img/photo.png)");
}
