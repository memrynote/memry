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

/// The open walk seeds a note's embed resolved whatever order it meets the files in. Here the
/// note sorts before its image (`notes/a.md`, `zimg/photo.png`): seeded before the image has
/// its row, the note would keep `![[photo.png]]` as written, and the hash rule never feeds an
/// unchanged file again.
#[test]
fn the_open_walk_resolves_an_embed_of_a_note_that_sorts_before_its_image() {
    let mut f = fixture();
    f.write("notes/a.md", "![[photo.png]]\n");
    f.write("zimg/photo.png", "x");
    let _running = super::flood::run(&f, 64);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, facts| {
        facts
            .iter()
            .any(|fact| matches!(fact, Applied::Indexed { .. }))
    });
    let body = f.body(&only_note(&f, "notes/a.md"));
    assert_eq!(body, "![photo.png](../zimg/photo.png)");
}
