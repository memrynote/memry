use super::*;

fn comment(start: i64) -> CriticMarkupMark {
    serde_json::from_value(serde_json::json!({
        "id": "c1", "kind": "comment", "visibleText": "beta", "body": "b",
        "start": start, "end": start + 4,
    }))
    .unwrap()
}

/// A suggestion of `visible` over "Old", at `start`.
fn suggestion(visible: &str, start: i64) -> CriticMarkupMark {
    serde_json::from_value(serde_json::json!({
        "id": "s1", "kind": "substitution", "visibleText": visible, "originalText": "Old",
        "start": start, "end": start + visible.len() as i64,
    }))
    .unwrap()
}

/// A comment `id` on the `beta` at `start`.
fn comment_with(id: &str, start: i64) -> CriticMarkupMark {
    CriticMarkupMark {
        id: id.to_owned(),
        ..comment(start)
    }
}

/// A suggestion of `visible` over `original`, at `start`.
fn suggestion_over(visible: &str, original: &str, start: i64) -> CriticMarkupMark {
    CriticMarkupMark {
        original_text: Some(original.to_owned()),
        ..suggestion(visible, start)
    }
}

/// The body serialized with the marks placed for it, `None` when the write-back is refused.
fn written(marks: &[CriticMarkupMark], plain: &str, file: Option<&str>) -> Option<String> {
    let read = || Ok(file.map(str::to_owned));
    let options = SerializeOptions {
        read_file_body: Some(&read),
        ..SerializeOptions::default()
    };
    placed_marks(marks, plain, &options).map(|marks| serialize_critic_markup(plain, &marks))
}

/// Two stale suggestions on the same words take distinct copies, so neither is dropped with
/// the text it replaced (VERIFY-5196B).
#[test]
fn stale_suggestions_on_the_same_words_take_distinct_copies() {
    let marks = [
        suggestion_over("Alpha", "One", 0),
        suggestion_over("Alpha", "Two", 0),
    ];
    let originals = |marks: &[CriticMarkupMark]| -> Vec<(i64, Option<String>)> {
        let body = written(marks, "x Alpha Alpha", None).unwrap();
        parse_critic_markup(&body)
            .marks
            .into_iter()
            .map(|mark| (mark.start, mark.original_text))
            .collect()
    };
    let at = |start, original: &str| (start, Some(original.to_owned()));
    assert_eq!(originals(&marks), [at(2, "One"), at(8, "Two")]);
    // A range that holds its words is taken before any stale mark searches for a copy.
    let holding = [marks[0].clone(), suggestion_over("Alpha", "Two", 2)];
    assert_eq!(originals(&holding), [at(2, "Two"), at(8, "One")]);
}

/// A peer ahead of the file added a comment on another copy of a filed comment's words, text
/// unchanged: a comment is the file's by its id only, so each keeps its range in either
/// array order (VERIFY-5196B).
#[test]
fn a_comment_takes_the_files_range_only_by_its_id() {
    let file = serialize_critic_markup("beta beta", &[comment(5)]);
    let (c1, c2) = (comment(5), comment_with("c2", 0));
    assert_eq!(
        placed(&[c2.clone(), c1.clone()], "beta beta", &file),
        Some(vec![0, 5])
    );
    assert_eq!(placed(&[c1, c2], "beta beta", &file), Some(vec![5, 0]));
}

/// The marks' starts, `None` when the write-back is refused.
fn placed(marks: &[CriticMarkupMark], plain: &str, file: &str) -> Option<Vec<i64>> {
    let read = || Ok(Some(file.to_owned()));
    let options = SerializeOptions {
        read_file_body: Some(&read),
        ..SerializeOptions::default()
    };
    placed_marks(marks, plain, &options).map(|marks| marks.iter().map(|mark| mark.start).collect())
}

/// The marks' starts for a write-back with no file to map against (FIX-5196B).
fn placed_without_file(marks: &[CriticMarkupMark], plain: &str) -> Option<Vec<i64>> {
    let read = || Ok(None);
    let options = SerializeOptions {
        read_file_body: Some(&read),
        ..SerializeOptions::default()
    };
    placed_marks(marks, plain, &options).map(|marks| marks.iter().map(|mark| mark.start).collect())
}

/// A kept note's restore and a held day's first file have no file to write over: a
/// suggestion whose range does not hold its words takes their first copy, and one whose
/// words are gone passes as it is, rather than the write being refused for good.
#[test]
fn without_a_file_a_stale_suggestion_takes_the_first_copy_of_its_words() {
    assert_eq!(
        placed_without_file(&[suggestion("Alpha", 0)], "beta Alpha"),
        Some(vec![5])
    );
    assert_eq!(
        placed_without_file(&[suggestion("Alpha", 0)], "beta"),
        Some(vec![0])
    );
}

/// A merge changed text away from the mark: a stale document range on another copy of its
/// words, over text the file already had, gives way to the file's range moved by the diff.
#[test]
fn after_a_merge_a_stale_range_on_another_copy_takes_the_files_range() {
    let file = serialize_critic_markup("beta beta beta x", &[suggestion("beta", 10)]);
    assert_eq!(
        placed(&[suggestion("beta", 5)], "beta beta beta y", &file),
        Some(vec![10])
    );
}

/// The decoded file's text is the document's, so its range wins over a stale one on another
/// copy; read with its markers, the file's text differs inside that copy and the stale range
/// would stand (VERIFY-5196).
#[test]
fn a_file_whose_markers_decode_to_the_documents_text_places_the_mark() {
    let rest = serialize_critic_markup(" beta", &[comment(1)]);
    let file = format!("be<!--ghost-->ta<!--/ghost-->{rest}");
    assert_eq!(placed(&[comment(0)], "beta beta", &file), Some(vec![5]));
}

/// A range that holds its text stays when the file is behind the document: a peer that
/// writes its offsets into the document (Electron) typed "beta " before the comment, and
/// the file's range, moved onto the document's text, lands on the first copy.
#[test]
fn a_document_range_that_holds_its_text_wins_over_the_file() {
    let file = serialize_critic_markup("beta", &[comment(0)]);
    assert_eq!(placed(&[comment(5)], "beta beta", &file), Some(vec![5]));
}

/// When the file's text is the document's, the file's range wins even over a document
/// range that holds the same words on another copy (REVIEW-5196 finding 3).
#[test]
fn the_files_range_wins_when_its_text_is_the_documents() {
    let file = serialize_critic_markup("beta beta beta\n", &[suggestion("beta", 10)]);
    assert_eq!(
        placed(&[suggestion("beta", 5)], "beta beta beta", &file),
        Some(vec![10])
    );
}

/// The file's writing markers count toward no offset (finding 1).
#[test]
fn the_files_writing_markers_do_not_shift_its_ranges() {
    let marked = serialize_critic_markup(" beta beta", &[comment(6)]);
    let file = format!("<!--alt:k1-->x<!--/alt:k1--><!--ghost-->{marked}<!--/ghost-->");
    assert_eq!(placed(&[comment(0)], "x beta beta", &file), Some(vec![7]));
}

/// A merge typed before the mark since the save: the file's range moves with the text
/// (finding 2).
#[test]
fn a_files_range_follows_text_merged_in_before_it() {
    let file = serialize_critic_markup("beta. Alpha and beta.\nlast", &[suggestion("Alpha", 6)]);
    let merged = "first\nHi beta. Alpha and beta.\nlast line";
    assert_eq!(
        placed(&[suggestion("Alpha", 6)], merged, &file),
        Some(vec![15])
    );
}

/// A merge deleted the suggestion's text: the write-back is refused rather than dropping the
/// suggestion and the text it replaced (finding 2).
#[test]
fn a_suggestion_whose_text_is_gone_refuses_the_write_back() {
    let file = serialize_critic_markup("beta. Alpha and beta.", &[suggestion("Alpha", 6)]);
    assert_eq!(
        placed(&[suggestion("Alpha", 6)], "beta. and beta.", &file),
        None
    );
}

/// The write-back of `marks` in array order, after checking the reversed order writes the
/// same (VERIFY-5196C).
fn written_in_both_orders(marks: &[CriticMarkupMark], plain: &str, file: &str) -> Option<String> {
    let forward = written(marks, plain, Some(file));
    let reversed: Vec<_> = marks.iter().rev().cloned().collect();
    assert_eq!(
        written(&reversed, plain, Some(file)),
        forward,
        "the order changed it"
    );
    forward
}

/// A deletion of the `beta` at `start`.
fn deletion(start: i64) -> CriticMarkupMark {
    serde_json::from_value(serde_json::json!({
        "id": format!("d{start}"), "kind": "deletion", "visibleText": "beta",
        "originalText": "beta", "start": start, "end": start + 4,
    }))
    .unwrap()
}

/// A comment with no stored id takes its id from its position, so typing before it breaks
/// its match with the file; it still takes a free copy of its words, never the placed
/// suggestion's (VERIFY-5196C finding 1).
#[test]
fn a_comment_with_no_stored_id_never_takes_a_placed_suggestions_words() {
    let file = "Z be{~~Old~>ta~~} {==beta==}{>>note<<}";
    // The window's marks from before it typed "Z ".
    let stale = parse_critic_markup("be{~~Old~>ta~~} {==beta==}{>>note<<}").marks;
    let body = written_in_both_orders(&stale, "Z beta beta", file).unwrap();
    let marks: Vec<_> = parse_critic_markup(&body)
        .marks
        .into_iter()
        .map(|mark| (mark.kind, mark.start, mark.original_text))
        .collect();
    assert_eq!(
        marks,
        [
            (CriticMarkupKind::Substitution, 4, Some("Old".to_owned())),
            (CriticMarkupKind::Comment, 7, None),
        ]
    );
}

/// A merge broke the comment's range in the file and its words' only copy holds a placed
/// suggestion: the write-back is refused rather than dropping either (VERIFY-5196C
/// finding 2).
#[test]
fn a_comment_whose_file_range_a_merge_broke_never_takes_a_placed_suggestions_words() {
    let marks = [suggestion_over("ta", "Old", 2), comment(5)];
    let file = serialize_critic_markup("beta beta", &marks);
    assert_eq!(written_in_both_orders(&marks, "beta beXta", &file), None);
}

/// The file behind the document holds one of two deletions of the same word: each keeps
/// its range in either order (VERIFY-5196C finding 3).
#[test]
fn deletions_of_the_same_word_keep_their_ranges_in_either_order() {
    let file = serialize_critic_markup("beta beta", &[deletion(5)]);
    assert_eq!(
        written_in_both_orders(&[deletion(0), deletion(5)], "beta beta", &file).as_deref(),
        Some("{--beta--} {--beta--}")
    );
}

/// A comment inside a suggestion is dropped and the suggestion written, as Electron's
/// serializer does, in either order (VERIFY-5196C finding 4); a suggestion takes its range
/// before any comment.
#[test]
fn a_comment_inside_a_suggestion_is_dropped() {
    let suggestion = suggestion_over("beta", "Old", 2);
    let file = serialize_critic_markup("Z beta", std::slice::from_ref(&suggestion));
    let inside = CriticMarkupMark {
        visible_text: "et".to_owned(),
        end: 5,
        ..comment(3)
    };
    let marks = [inside, suggestion];
    assert_eq!(
        written_in_both_orders(&marks, "Z beta", &file),
        Some(file.clone())
    );
    // A peer added the suggestion since the save: neither mark is in the file.
    assert_eq!(
        written_in_both_orders(&marks, "Z beta", "Z beta"),
        Some(file)
    );
}

/// A stale range takes the file's; with no such mark in the file it stays as it was.
#[test]
fn a_stale_range_takes_the_files_range_of_the_same_mark() {
    let file = serialize_critic_markup("x beta beta", &[comment(7)]);
    assert_eq!(placed(&[comment(4)], "x beta beta", &file), Some(vec![7]));
    assert_eq!(
        placed(&[comment(4)], "x beta beta", "x beta beta"),
        Some(vec![4])
    );
}
