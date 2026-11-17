//! The attachment change plan (#3535): Electron's backfill, revival and
//! release decisions, and the two properties that guard against data loss.

use std::collections::BTreeSet;

use memry_core::sync::attachments::plan::{
    COUNTED_EMPTY, ChangePlan, FileRecord, NoteAttachments, RELEASE_GRACE_MS, RecordMove,
    attachments_to_free, in_grace, release_is_due,
};
use memry_test_kit::proptest_config;
use proptest::prelude::*;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn record(path: &str, id: Option<&str>, on_disk: bool) -> FileRecord {
    FileRecord {
        path: path.to_owned(),
        attachment_id: id.map(str::to_owned),
        on_disk,
    }
}

fn note() -> NoteAttachments {
    NoteAttachments {
        note_id: "n1".to_owned(),
        ..NoteAttachments::default()
    }
}

#[test]
fn an_upload_merges_into_the_references() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        references: strings(&["a", "b"]),
        uploaded: strings(&["b", "c"]),
        ..note()
    });
    assert_eq!(plan.keep, strings(&["a", "b", "c"]));
    assert!(plan.drop_gone.is_empty());
}

#[test]
fn unrecorded_files_are_offered_and_recorded_ones_are_not() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/x.png", "img/y.png", "img/y.png"]),
        records: vec![record("attachments/n1/x.png", Some("a"), true)],
        references: strings(&["a"]),
        ..note()
    });
    assert_eq!(plan.offer, strings(&["img/y.png"]));
    assert!(plan.count_known.is_empty());
}

/// `attachment-files.ts` module comment: a note with references and no record
/// predates the records, so its files count as known.
#[test]
fn a_note_from_before_the_records_counts_its_files() {
    let with_files = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/x.png"]),
        references: strings(&["a"]),
        ..note()
    });
    assert!(with_files.offer.is_empty());
    assert_eq!(with_files.count_known, strings(&["attachments/n1/x.png"]));

    let without_files = ChangePlan::for_note(&NoteAttachments {
        references: strings(&["a"]),
        ..note()
    });
    assert_eq!(without_files.count_known, strings(&[COUNTED_EMPTY]));

    let fresh = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/x.png"]),
        ..note()
    });
    assert_eq!(fresh.offer, strings(&["attachments/n1/x.png"]));
}

#[test]
fn a_renamed_file_takes_over_its_record() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&[
            "attachments/n1/abc123-new.png",
            "attachments/n1/zzz999-other.png",
        ]),
        records: vec![
            record("attachments/n1/abc123-old.png", Some("a"), false),
            record("attachments/n1/zzz999-kept.png", Some("b"), true),
        ],
        references: strings(&["a", "b"]),
        ..note()
    });
    assert_eq!(
        plan.move_records,
        vec![RecordMove {
            from: "attachments/n1/abc123-old.png".to_owned(),
            to: "attachments/n1/abc123-new.png".to_owned(),
        }]
    );
    // The other file's prefix matches a record still on disk: a new file.
    assert_eq!(plan.offer, strings(&["attachments/n1/zzz999-other.png"]));
}

/// A file renamed in the note folder while its attachment is gone: the record
/// follows the file to its new name, and the file under that name goes up again.
#[test]
fn a_renamed_file_whose_attachment_is_gone_is_reuploaded() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/abc123-new.png"]),
        records: vec![record("attachments/n1/abc123-old.png", Some("a"), false)],
        references: strings(&["a"]),
        gone: set(&["a"]),
        ..note()
    });
    assert_eq!(plan.drop_gone, strings(&["a"]));
    assert_eq!(plan.reupload, strings(&["attachments/n1/abc123-new.png"]));
    assert_eq!(
        plan.move_records,
        vec![RecordMove {
            from: "attachments/n1/abc123-old.png".to_owned(),
            to: "attachments/n1/abc123-new.png".to_owned(),
        }]
    );
}

#[test]
fn a_local_only_note_offers_nothing() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        local_only: true,
        files: strings(&["attachments/n1/x.png"]),
        references: strings(&["a"]),
        gone: set(&["a"]),
        ..note()
    });
    assert_eq!(plan.keep, strings(&["a"]));
    assert!(plan.offer.is_empty() && plan.reupload.is_empty() && plan.drop_gone.is_empty());
}

#[test]
fn a_revived_note_drops_gone_ids_and_reuploads_their_files() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/x.png", "attachments/n1/y.png"]),
        records: vec![
            record("attachments/n1/x.png", Some("a"), true),
            record("attachments/n1/y.png", Some("b"), true),
        ],
        references: strings(&["a", "b"]),
        gone: set(&["a", "unrelated"]),
        ..note()
    });
    assert_eq!(plan.keep, strings(&["b"]));
    assert_eq!(plan.drop_gone, strings(&["a"]));
    assert_eq!(plan.reupload, strings(&["attachments/n1/x.png"]));
}

/// `filesOfAttachments`: an id no record names may be any file not recorded
/// under another attachment.
#[test]
fn an_unnamed_gone_id_reuploads_every_file_not_held_by_another() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&["attachments/n1/x.png", "attachments/n1/y.png", "img/z.png"]),
        records: vec![
            record("attachments/n1/y.png", Some("b"), true),
            record("img/z.png", None, true),
        ],
        references: strings(&["a", "b"]),
        gone: set(&["a"]),
        ..note()
    });
    assert_eq!(
        plan.reupload,
        strings(&["attachments/n1/x.png", "img/z.png"])
    );
}

#[test]
fn a_file_note_whose_own_attachment_is_gone_reuploads_its_file() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        own_attachment_id: Some("own".to_owned()),
        file_note_path: Some("docs/report.pdf".to_owned()),
        records: vec![record("docs/report.pdf", Some("own"), false)],
        gone: set(&["own"]),
        ..note()
    });
    assert_eq!(plan.reupload, strings(&["docs/report.pdf"]));
    assert!(plan.drop_gone.is_empty(), "the own id is not a reference");
}

#[test]
fn a_deleted_note_schedules_its_ids_and_nothing_else() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        deleted: true,
        references: strings(&["a", "b", "a"]),
        own_attachment_id: Some("b".to_owned()),
        files: strings(&["attachments/n1/x.png"]),
        gone: set(&["a"]),
        ..note()
    });
    assert_eq!(plan.schedule_release, strings(&["a", "b"]));
    assert_eq!(plan.keep, strings(&["a", "b", "a"]));
    assert!(plan.offer.is_empty() && plan.reupload.is_empty() && plan.drop_gone.is_empty());
}

/// An upload that landed after the delete is released with the note's ids.
#[test]
fn a_deleted_note_releases_an_upload_that_landed_after_the_delete() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        deleted: true,
        references: strings(&["a"]),
        uploaded: strings(&["late", "a"]),
        ..note()
    });
    assert_eq!(plan.schedule_release, strings(&["a", "late"]));
}

#[test]
fn the_grace_period_ends_where_the_release_is_due() {
    let deleted_at = 1_000_000;
    for now in [
        deleted_at,
        deleted_at + RELEASE_GRACE_MS - 1,
        deleted_at + RELEASE_GRACE_MS,
        deleted_at + RELEASE_GRACE_MS + 1,
    ] {
        assert_eq!(in_grace(deleted_at, now), !release_is_due(deleted_at, now));
    }
    assert!(in_grace(deleted_at, deleted_at + RELEASE_GRACE_MS - 1));
    assert!(!in_grace(deleted_at, deleted_at + RELEASE_GRACE_MS));
}

#[test]
fn a_release_is_due_on_day_30_and_not_on_day_29() {
    let deleted_at = 1_000_000;
    let day = 24 * 60 * 60 * 1000;
    assert!(!release_is_due(deleted_at, deleted_at + 29 * day));
    assert!(!release_is_due(
        deleted_at,
        deleted_at + RELEASE_GRACE_MS - 1
    ));
    assert!(release_is_due(deleted_at, deleted_at + RELEASE_GRACE_MS));
    assert!(release_is_due(deleted_at, deleted_at + 31 * day));
}

#[test]
fn a_release_skips_referenced_ids_and_live_owners() {
    let recorded = strings(&["a", "b", "c", "a"]);
    assert_eq!(
        attachments_to_free(&recorded, false, &set(&["b"])),
        strings(&["a", "c"])
    );
    assert!(attachments_to_free(&recorded, true, &BTreeSet::new()).is_empty());
}

fn ids() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec("[a-f]", 0..6)
}

fn paths() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec(
        prop_oneof![
            "attachments/n1/[ab]bc123-[xyz]\\.png",
            "attachments/n1/[xy]\\.png",
            "img/[xyz]\\.png",
        ],
        0..6,
    )
}

fn any_note() -> impl Strategy<Value = NoteAttachments> {
    (
        (any::<bool>(), ids(), ids(), proptest::option::of("[a-f]")),
        (
            paths(),
            paths(),
            prop::collection::vec((proptest::option::of("[a-f]"), any::<bool>()), 0..6),
        ),
        prop::collection::btree_set("[a-f]", 0..4),
    )
        .prop_map(
            |((local_only, references, uploaded, own), (files, recorded, meta), gone)| {
                let mut seen = BTreeSet::new();
                let records = recorded
                    .into_iter()
                    .zip(meta)
                    .filter(|(path, _)| seen.insert(path.clone()))
                    .map(|(path, (attachment_id, on_disk))| FileRecord {
                        on_disk: on_disk || files.contains(&path),
                        path,
                        attachment_id,
                    })
                    .collect();
                NoteAttachments {
                    note_id: "n1".to_owned(),
                    local_only,
                    references,
                    uploaded,
                    own_attachment_id: own,
                    files,
                    records,
                    gone,
                    ..NoteAttachments::default()
                }
            },
        )
}

/// `any_note` plus a file renamed in the note folder whose attachment is gone,
/// a shape the random paths reach too rarely to count on.
fn renamed_gone_note() -> impl Strategy<Value = NoteAttachments> {
    any_note().prop_map(|mut note| {
        note.local_only = false;
        note.files.push("attachments/n1/qqq999-new.png".to_owned());
        note.records
            .push(record("attachments/n1/qqq999-old.png", Some("a"), false));
        note.references.push("a".to_owned());
        note.gone.insert("a".to_owned());
        note
    })
}

proptest! {
    #![proptest_config(proptest_config(512))]

    /// A reference leaves a note only on proof that it is gone.
    #[test]
    fn a_reference_is_dropped_only_when_proven_gone(note in any_note()) {
        let plan = ChangePlan::for_note(&note);
        for id in note.references.iter().chain(&note.uploaded) {
            if note.gone.contains(id) && !note.local_only {
                prop_assert!(!plan.keep.contains(id));
                prop_assert!(plan.drop_gone.contains(id));
            } else {
                prop_assert!(plan.keep.contains(id), "{id} dropped without proof");
            }
        }
        for id in &plan.drop_gone {
            prop_assert!(note.gone.contains(id));
        }
    }

    /// Every file on disk whose record (after the plan's moves) names a gone
    /// reference or the note's own gone id goes up again.
    #[test]
    fn every_file_of_a_gone_attachment_is_reuploaded(
        note in prop_oneof![any_note(), renamed_gone_note()],
    ) {
        let plan = ChangePlan::for_note(&note);
        let mut records = note.records.clone();
        for RecordMove { from, to } in &plan.move_records {
            let row = records.iter_mut().find(|r| r.path == *from).expect("moved row");
            row.path = to.clone();
            row.on_disk = true;
        }
        let named: BTreeSet<&String> = note
            .references
            .iter()
            .chain(&note.uploaded)
            .chain(&note.own_attachment_id)
            .collect();
        for record in records.iter().filter(|r| r.on_disk && !note.local_only) {
            if let Some(id) = &record.attachment_id
                && named.contains(id)
                && note.gone.contains(id)
            {
                prop_assert!(
                    plan.reupload.contains(&record.path),
                    "{} holds gone {id} and is not reuploaded", record.path
                );
            }
        }
    }

    /// The release never frees an id something still names.
    #[test]
    fn a_release_never_frees_a_referenced_id(
        recorded in ids(),
        still in prop::collection::btree_set("[a-f]", 0..6),
        owner_live in any::<bool>(),
    ) {
        let freed = attachments_to_free(&recorded, owner_live, &still);
        prop_assert!(freed.iter().all(|id| !still.contains(id) && recorded.contains(id)));
        prop_assert!(!owner_live || freed.is_empty());
    }

    /// Offered files are the note's unrecorded files, and once the plan's
    /// record writes land, the next plan offers the same and writes nothing.
    #[test]
    fn the_backfill_converges(mut note in any_note()) {
        note.gone.clear();
        let first = ChangePlan::for_note(&note);
        let recorded: BTreeSet<&String> = note.records.iter().map(|r| &r.path).collect();
        for file in &first.offer {
            prop_assert!(note.files.contains(file) && !recorded.contains(file));
        }

        for path in &first.count_known {
            note.records.push(FileRecord {
                on_disk: note.files.contains(path),
                path: path.clone(),
                attachment_id: None,
            });
        }
        for RecordMove { from, to } in &first.move_records {
            let row = note.records.iter_mut().find(|r| r.path == *from).expect("moved row");
            row.path = to.clone();
            row.on_disk = true;
        }
        let second = ChangePlan::for_note(&note);
        prop_assert!(second.count_known.is_empty() && second.move_records.is_empty());
        prop_assert_eq!(second.offer, first.offer);
    }
}

#[test]
fn one_old_record_is_taken_over_once() {
    let plan = ChangePlan::for_note(&NoteAttachments {
        files: strings(&[
            "attachments/n1/abc123-one.png",
            "attachments/n1/abc123-two.png",
        ]),
        records: vec![record("attachments/n1/abc123-old.png", Some("a"), false)],
        references: strings(&["a"]),
        ..note()
    });
    assert_eq!(plan.move_records.len(), 1);
    assert_eq!(plan.offer, strings(&["attachments/n1/abc123-two.png"]));
}
