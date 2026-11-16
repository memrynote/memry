//! The note embedding lane over the text read out of files (Step 25 lane H, #3542), after
//! Electron's `embedding-projector.ts`, on the real vault and index of
//! [`crate::embedding_lane`].
//!
//! | Test                                                      | Rule                                 |
//! | --------------------------------------------------------- | ------------------------------------ |
//! | a file with text read is embedded from that text           | `embedFileText`, :360-370            |
//! | a markdown note's input ends with its attachments' text    | `withAttachmentText`, :128-133, 452  |
//! | a read whose event never came is owed and reconciled       | the recorded hash names the text     |
//! | a file whose text is gone loses its vectors                | `embedFileText`, :363-366            |

use memry_core::domain::file_text::{ExtractedTextMethod, TextSource};
use memry_desktop::session::projection::{ProjectionEvent, feed};

use crate::embedding_lane::{ALPHA, Lane, lane};

fn source(note_id: &str, source: &str) -> TextSource {
    TextSource {
        note_id: note_id.to_owned(),
        source: source.to_owned(),
    }
}

/// Part 1 of `of` read as `text`, as the file text runner saves it.
fn read(l: &Lane, of: TextSource, text: &str) {
    let open = l.e.session.current().expect("open");
    open.search
        .save_extracted_part(of, 1, ExtractedTextMethod::PdfText, text.to_owned())
        .unwrap();
}

/// The runner's flush event (`note.text-extracted`).
fn extracted(l: &Lane, note_id: &str) {
    let note_id = note_id.to_owned();
    feed::publish(&l.e.session, ProjectionEvent::NoteTextExtracted { note_id });
}

const PAGE: &str = "Quarterly revenue grew across the northern region";
const SHOT: &str = "Whiteboard sketch of the deploy pipeline";

#[test]
fn a_file_with_text_read_is_embedded_from_that_text() {
    let mut l = lane();
    let id = l.write("doc.pdf", "%PDF-1.4 not really a pdf");
    l.settled();
    assert_eq!(l.state(&id), None, "no text read yet");

    read(&l, source(&id, ""), PAGE);
    extracted(&l, &id);
    l.embedded(&id);
    let head = l.head_text(&id).expect("a head vector of the model's");
    assert!(head.contains(PAGE) && head.contains("doc"), "{head}");
    assert!(!head.contains("%PDF"), "{head}");
}

#[test]
fn a_markdown_note_input_ends_with_its_attachment_text() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);

    read(&l, source(&id, "shot.png"), SHOT);
    extracted(&l, &id);
    l.until("the vector with the attachment text", |l| {
        l.head_text(&id).is_some_and(|text| text.contains(SHOT))
    });
    let head = l.head_text(&id).unwrap();
    assert!(head.contains("first body"), "{head}");
    assert!(head.find("first body") < head.find(SHOT), "{head}");
}

#[test]
fn a_read_whose_event_never_came_is_owed_and_reconciled() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.settled();
    assert!(l.owed().is_empty());

    read(&l, source(&id, "shot.png"), SHOT);
    l.owes(&id);
    l.reconcile();
    assert!(l.head_text(&id).unwrap().contains(SHOT));
    assert!(l.owed().is_empty());
}

#[test]
fn a_file_whose_text_is_gone_loses_its_vectors() {
    let mut l = lane();
    let id = l.write("doc.pdf", "%PDF-1.4 not really a pdf");
    read(&l, source(&id, ""), PAGE);
    extracted(&l, &id);
    l.embedded(&id);

    let open = l.e.session.current().expect("open");
    open.search.delete_text_source(source(&id, "")).unwrap();
    extracted(&l, &id);
    l.until("no vectors", |l| {
        l.state(&id).is_none() && l.head(&id).is_none()
    });
}
