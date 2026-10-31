use super::*;

/// The write-back restores the author's spelling from the file, which parses as the seed did
/// only with its image embeds resolved: an embed the file writes as `![[photo.png]]` stays so
/// when another block of the note is edited in the app.
#[test]
fn an_app_edit_keeps_the_file_s_image_embeds_as_written() {
    let mut f = fixture();
    f.write("img/photo.png", "x");
    f.record_as("image", "img/photo.png", FileType::Image, None);
    let id = f.adopt("notes/a.md", "first\n\n![[photo.png]]\n");
    f.edit_in_app(&id, "typed in the app");
    let outcome = f.run(&id);
    let written = assert_wrote(&mut f, &outcome, "notes/a.md");
    assert_eq!(written, "typed in the app\n\n![[photo.png]]\n");
}
