//! The cases of Electron's `canvas/folder-paths.test.ts`, plus properties over
//! peer-sent folders.

use proptest::prelude::*;
use unicode_normalization::UnicodeNormalization;

use super::*;

fn at_cap() -> String {
    (1..=MAX_CANVAS_FOLDER_DEPTH)
        .map(|i| format!("d{i}"))
        .collect::<Vec<_>>()
        .join("/")
}

fn past_cap() -> String {
    format!("{}/d{}", at_cap(), MAX_CANVAS_FOLDER_DEPTH + 1)
}

#[test]
fn normalize_folder_treats_empty_ish_values_as_root() {
    for folder in [None, Some(""), Some("   "), Some("."), Some("/")] {
        assert_eq!(normalize_folder(folder), Ok(None), "{folder:?}");
    }
}

#[test]
fn normalize_folder_strips_and_collapses_slashes() {
    assert_eq!(normalize_folder(Some("/Work/")), Ok(Some("Work".into())));
    assert_eq!(
        normalize_folder(Some("Work//Q3")),
        Ok(Some("Work/Q3".into()))
    );
}

#[test]
fn normalize_folder_drops_traversal_segments() {
    assert_eq!(normalize_folder(Some("..")), Ok(None));
    assert_eq!(normalize_folder(Some("../..")), Ok(None));
    assert_eq!(normalize_folder(Some("Work/..")), Ok(Some("Work".into())));
    assert_eq!(normalize_folder(Some("../../etc")), Ok(Some("etc".into())));
}

#[test]
fn normalize_folder_refuses_a_folder_past_the_depth_cap() {
    assert_eq!(normalize_folder(Some(&at_cap())), Ok(Some(at_cap())));
    assert_eq!(
        normalize_folder(Some(&past_cap())),
        Err(CanvasFolderError::Depth)
    );
    assert!(
        CanvasFolderError::Depth.to_string().contains("deeper than"),
        "the message Electron's test matches"
    );
}

#[test]
fn normalize_stored_folder_cleans_up_and_keeps_a_deep_folder_in_full() {
    assert_eq!(normalize_stored_folder(None), None);
    assert_eq!(normalize_stored_folder(Some("  ")), None);
    assert_eq!(
        normalize_stored_folder(Some("/Work//Q3/")),
        Some("Work/Q3".into())
    );
    assert_eq!(
        normalize_stored_folder(Some("Work/..")),
        Some("Work".into())
    );
    assert_eq!(normalize_stored_folder(Some(&past_cap())), Some(past_cap()));
}

#[test]
fn trimming_follows_javascript_not_rust() {
    // JavaScript strips a BOM and keeps NEL; Rust's `trim` does the opposite.
    assert_eq!(
        normalize_stored_folder(Some("\u{feff}Work\u{feff}")),
        Some("Work".into())
    );
    assert_eq!(
        normalize_stored_folder(Some("\u{85}Work")),
        Some("\u{85}Work".into())
    );
    assert_eq!(
        normalize_stored_folder(Some("\u{3000} Work\t/\u{a0}Q3\n")),
        Some("Work/Q3".into())
    );
}

#[test]
fn join_folder_joins_onto_root_and_a_parent() {
    assert_eq!(join_folder(None, "Work"), Ok("Work".into()));
    assert_eq!(join_folder(Some("Work"), "Q3"), Ok("Work/Q3".into()));
}

#[test]
fn join_folder_refuses_a_traversal_name_and_a_join_past_the_cap() {
    assert_eq!(
        join_folder(Some("Work"), ".."),
        Err(CanvasFolderError::InvalidName)
    );
    assert!(
        CanvasFolderError::InvalidName
            .to_string()
            .contains("cannot be empty")
    );
    let cap = at_cap();
    let parent = cap.rsplit_once('/').map(|(parent, _)| parent);
    assert_eq!(
        join_folder(parent, &format!("d{MAX_CANVAS_FOLDER_DEPTH}")),
        Ok(cap.clone())
    );
    assert_eq!(
        join_folder(Some(&cap), "deeper"),
        Err(CanvasFolderError::Depth)
    );
}

#[test]
fn parent_folder_walks_up_one_level() {
    assert_eq!(parent_folder(Some("Work/Q3")), Some("Work".into()));
    assert_eq!(parent_folder(Some("Work")), None);
    assert_eq!(parent_folder(None), None);
}

#[test]
fn is_descendant_folder_matches_self_and_descendants_only() {
    assert!(is_descendant_folder(Some("Work"), Some("Work")));
    assert!(is_descendant_folder(Some("Work/Q3"), Some("Work")));
    assert!(is_descendant_folder(Some("Work/Q3/Deep"), Some("Work")));
    assert!(!is_descendant_folder(Some("Workshop"), Some("Work")));
    assert!(!is_descendant_folder(Some("Personal"), Some("Work")));
    assert!(!is_descendant_folder(Some("Work"), Some("Work/Q3")));
    assert!(is_descendant_folder(Some("Work/Q3"), None));
    assert!(is_descendant_folder(None, None));
    assert!(is_descendant_folder(Some("work/q3"), Some("Work")));
}

#[test]
fn is_descendant_folder_treats_nfd_and_nfc_as_one_folder() {
    let composed: String = "Yağmur".nfc().collect();
    let decomposed: String = "Yağmur".nfd().collect();
    assert_ne!(composed, decomposed);
    assert!(is_descendant_folder(
        Some(&format!("{decomposed}/Q3")),
        Some(&composed)
    ));
    assert!(is_descendant_folder(Some(&composed), Some(&decomposed)));
    assert!(is_descendant_folder(
        Some(&decomposed.to_uppercase()),
        Some(&composed)
    ));
}

#[test]
fn rewrite_folder_prefix_moves_the_folder_and_its_descendants_only() {
    let rewrite = |folder: Option<&str>| rewrite_folder_prefix(folder, "Work", "Job");
    assert_eq!(rewrite(Some("Work")), Ok(Some("Job".into())));
    assert_eq!(rewrite(Some("Work/Q3")), Ok(Some("Job/Q3".into())));
    assert_eq!(rewrite(Some("Workshop")), Ok(Some("Workshop".into())));
    assert_eq!(rewrite(None), Ok(None));
    assert_eq!(rewrite(Some(&past_cap())), Ok(Some(past_cap())));
}

#[test]
fn rewrite_folder_prefix_refuses_a_root_source_and_a_result_past_the_cap() {
    for from in ["", "   ", "."] {
        assert_eq!(
            rewrite_folder_prefix(Some("Work/Q3"), from, "Job"),
            Err(CanvasFolderError::NoSource)
        );
    }
    assert!(
        CanvasFolderError::NoSource
            .to_string()
            .contains("source folder")
    );
    assert_eq!(
        rewrite_folder_prefix(Some("Work"), "Work", &at_cap()),
        Ok(Some(at_cap()))
    );
    assert_eq!(
        rewrite_folder_prefix(Some("Work/Q3"), "Work", &at_cap()),
        Err(CanvasFolderError::Depth)
    );
}

#[test]
fn folder_segments_splits_a_folder_into_its_parts() {
    assert_eq!(folder_segments(Some("Work/Q3")), vec!["Work", "Q3"]);
    assert!(folder_segments(None).is_empty());
}

#[test]
fn a_folder_error_reaches_storage_as_its_electron_code() {
    let error: StorageError = CanvasFolderError::Depth.into();
    assert!(error.to_string().contains("CANVAS_FOLDER_DEPTH"), "{error}");
}

fn segment() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("..".to_owned()),
        Just(".".to_owned()),
        Just(String::new()),
        Just(" \u{feff}".to_owned()),
        "[A-Za-z0-9 ._\\-\u{e7}\u{11f}]{0,6}",
    ]
}

proptest! {
    #![proptest_config(memry_test_kit::proptest_config(memry_test_kit::DEFAULT_CASES))]

    /// A folder a peer sends never cleans up into a path that walks out of
    /// `canvases/`, and cleaning it up twice changes nothing.
    #[test]
    fn a_stored_folder_never_carries_a_traversal_segment(
        segments in prop::collection::vec(segment(), 0..12)
    ) {
        let raw = segments.join("/");
        let stored = normalize_stored_folder(Some(&raw));
        if let Some(stored) = &stored {
            for part in stored.split('/') {
                prop_assert!(!part.is_empty() && part != "." && part != "..", "{stored:?}");
                prop_assert_eq!(part, js_trim(part));
            }
            prop_assert!(stored.len() <= raw.len());
        }
        prop_assert_eq!(normalize_stored_folder(stored.as_deref()), stored.clone());
        match normalize_folder(Some(&raw)) {
            Ok(strict) => prop_assert_eq!(strict, stored),
            Err(error) => {
                prop_assert_eq!(error, CanvasFolderError::Depth);
                prop_assert!(folder_segments(Some(&raw)).len() > MAX_CANVAS_FOLDER_DEPTH);
            }
        }
    }
}
