//! Electron's `similarity/scoring.test.ts`, case for case.

use super::*;

fn neighbour(similarity: f64, tags: &[&str]) -> TagNeighbour {
    TagNeighbour {
        similarity,
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
    }
}

fn names(scored: &[ScoredTag]) -> Vec<&str> {
    scored.iter().map(|t| t.tag.as_str()).collect()
}

fn item(id: &str, vector: &[f32]) -> (String, Vec<f32>) {
    (id.to_owned(), vector.to_vec())
}

fn member(tags: &[&str], folder: &str) -> GroupMember {
    GroupMember {
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        folder: folder.to_owned(),
    }
}

#[test]
fn cosine_is_1_for_parallel_and_0_for_orthogonal_vectors() {
    assert!((cosine_similarity(&[1.0, 2.0], &[2.0, 4.0]) - 1.0).abs() < 1e-9);
    assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-9);
}

#[test]
fn cosine_is_0_when_a_vector_has_no_length() {
    assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
}

#[test]
fn corroboration_discounts_a_lone_hit_and_caps_support() {
    assert_eq!(corroborated_similarity(&[]), 0.0);
    assert!((corroborated_similarity(&[0.9]) - 0.63).abs() < 1e-12);
    // Only the best three count: 0.8 average, kept at 90%.
    let sims = [0.1, 0.9, 0.8, 0.7, 0.2];
    assert!((corroborated_similarity(&sims) - 0.72).abs() < 1e-12);
}

#[test]
fn prefers_a_tag_several_neighbours_agree_on_over_one_close_fluke() {
    // A lone hit keeps 70% of its similarity (0.63); three agreeing neighbours keep
    // 90% (0.675), so the pattern outranks the fluke.
    let scored = score_neighbour_tags(
        &[
            neighbour(0.9, &["fluke"]),
            neighbour(0.75, &["sleep"]),
            neighbour(0.75, &["sleep"]),
            neighbour(0.75, &["sleep"]),
        ],
        &TagScoringOptions {
            min_support: 1,
            ..TagScoringOptions::default()
        },
    );
    assert_eq!(names(&scored), ["sleep", "fluke"]);
    assert_eq!(scored[0].support, 3);
}

#[test]
fn drops_tags_the_note_already_has_by_identity() {
    let scored = score_neighbour_tags(
        &[
            neighbour(0.7, &["Health", "sleep"]),
            neighbour(0.7, &["health", "sleep"]),
            neighbour(0.7, &["İş"]),
        ],
        &TagScoringOptions {
            exclude: vec!["HEALTH".into(), "iş".into()],
            ..TagScoringOptions::default()
        },
    );
    assert_eq!(names(&scored), ["sleep"]);
}

#[test]
fn applies_similarity_support_and_confidence_floors() {
    let neighbours = [
        neighbour(0.2, &["far"]),
        neighbour(0.2, &["far"]),
        neighbour(0.8, &["alone"]),
        neighbour(0.5, &["pair"]),
        neighbour(0.5, &["pair"]),
    ];
    let floors = TagScoringOptions {
        min_similarity: 0.3,
        min_support: 2,
        ..TagScoringOptions::default()
    };
    assert_eq!(names(&score_neighbour_tags(&neighbours, &floors)), ["pair"]);
    let confident = TagScoringOptions {
        min_similarity: 0.3,
        min_confidence: 0.9,
        ..TagScoringOptions::default()
    };
    assert!(score_neighbour_tags(&neighbours, &confident).is_empty());
}

#[test]
fn shows_the_casing_most_neighbours_use() {
    let scored = score_neighbour_tags(
        &[
            neighbour(0.6, &["Sleep"]),
            neighbour(0.6, &["sleep"]),
            neighbour(0.6, &["sleep"]),
        ],
        &TagScoringOptions::default(),
    );
    assert_eq!(scored[0].tag, "sleep");
}

#[test]
fn a_casing_tie_shows_the_first_spelling_seen() {
    let scored = score_neighbour_tags(
        &[neighbour(0.6, &["Sleep"]), neighbour(0.6, &["sleep"])],
        &TagScoringOptions::default(),
    );
    assert_eq!(scored[0].tag, "Sleep");
}

#[test]
fn equal_confidence_ranks_the_tag_more_neighbours_carry_first() {
    // Confidence counts the best three; the fourth neighbour only adds support.
    let scored = score_neighbour_tags(
        &[
            neighbour(0.6, &["few", "many"]),
            neighbour(0.6, &["few", "many"]),
            neighbour(0.6, &["few", "many"]),
            neighbour(0.6, &["many"]),
        ],
        &TagScoringOptions::default(),
    );
    assert_eq!(scored[0].confidence, scored[1].confidence);
    assert_eq!(names(&scored), ["many", "few"]);
}

#[test]
fn a_duplicate_tag_on_one_neighbour_counts_once() {
    let scored = score_neighbour_tags(
        &[neighbour(0.6, &["sleep", "Sleep"])],
        &TagScoringOptions::default(),
    );
    assert_eq!(scored.len(), 1);
    assert_eq!((scored[0].tag.as_str(), scored[0].support), ("sleep", 1));
}

#[test]
fn ties_keep_first_seen_order_and_respect_the_limit() {
    let scored = score_neighbour_tags(
        &[
            neighbour(0.6, &["a", "b", "c"]),
            neighbour(0.6, &["a", "b", "c"]),
        ],
        &TagScoringOptions {
            limit: Some(2),
            ..TagScoringOptions::default()
        },
    );
    assert_eq!(names(&scored), ["a", "b"]);
}

#[test]
fn groups_items_by_topic_and_leaves_outliers_ungrouped() {
    let result = cluster_by_similarity(
        &[
            item("sleep-1", &[1.0, 0.1, 0.0]),
            item("code-1", &[0.0, 1.0, 0.1]),
            item("sleep-2", &[0.9, 0.2, 0.0]),
            item("code-2", &[0.1, 1.0, 0.0]),
            item("code-3", &[0.0, 0.9, 0.2]),
            item("outlier", &[0.0, 0.0, 1.0]),
        ],
        0.8,
    );
    assert_eq!(
        result.groups,
        [
            vec!["code-1", "code-2", "code-3"],
            vec!["sleep-1", "sleep-2"]
        ]
    );
    assert_eq!(result.ungrouped, ["outlier"]);
}

#[test]
fn does_not_chain_two_topics_through_one_bridging_item() {
    // `bridge` is close to both ends, but the ends are unrelated: average linkage
    // must not pull all three into one group.
    let result = cluster_by_similarity(
        &[
            item("a", &[1.0, 0.0]),
            item("bridge", &[1.0, 1.0]),
            item("b", &[0.0, 1.0]),
        ],
        0.6,
    );
    // The a-bridge pair ties bridge-b and comes first.
    assert_eq!(result.groups, [vec!["a", "bridge"]]);
    assert_eq!(result.ungrouped, ["b"]);
}

#[test]
fn groups_of_equal_size_keep_input_order() {
    let result = cluster_by_similarity(
        &[
            item("x1", &[0.0, 1.0]),
            item("y1", &[1.0, 0.0]),
            item("y2", &[1.0, 0.0]),
            item("x2", &[0.0, 1.0]),
        ],
        0.9,
    );
    assert_eq!(result.groups, [vec!["x1", "x2"], vec!["y1", "y2"]]);
}

#[test]
fn clusters_empty_and_single_inputs() {
    assert_eq!(cluster_by_similarity(&[], 0.5), Clusters::default());
    assert_eq!(
        cluster_by_similarity(&[item("x", &[1.0])], 0.5),
        Clusters {
            groups: Vec::new(),
            ungrouped: vec!["x".into()],
        }
    );
}

#[test]
fn names_a_group_by_a_tag_most_members_share() {
    let name = suggest_group_name(&[
        member(&["health/sleep"], "a"),
        member(&["Health/Sleep", "x"], "b"),
        member(&[], "c"),
    ]);
    assert_eq!(name.as_deref(), Some("health/sleep"));
}

#[test]
fn falls_back_to_the_last_segment_of_a_shared_folder() {
    let name = suggest_group_name(&[member(&[], "areas/health"), member(&["a"], "areas/health")]);
    assert_eq!(name.as_deref(), Some("health"));
}

#[test]
fn an_empty_shared_tag_falls_back_to_the_folder() {
    let name = suggest_group_name(&[member(&[""], "areas/health"), member(&[""], "areas/health")]);
    assert_eq!(name.as_deref(), Some("health"));
}

#[test]
fn has_no_name_when_nothing_is_shared_by_half_the_group() {
    let members = [
        member(&["a"], "x"),
        member(&["b"], "y"),
        member(&["c"], "z"),
    ];
    assert_eq!(suggest_group_name(&members), None);
    assert_eq!(suggest_group_name(&[]), None);
    // Root notes share no folder.
    assert_eq!(
        suggest_group_name(&[member(&[], ""), member(&[], "")]),
        None
    );
}
