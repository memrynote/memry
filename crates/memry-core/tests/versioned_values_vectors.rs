//! The `versioned-values` conformance class (chapter 06 §6.11): the order,
//! joins, stamps and plain read of `tag_definition.schema` and `task.fields`.
//!
//! The core carries both keys verbatim and merges neither (§6.11.5), so the
//! rules below are the second implementation the class is checked against,
//! written from the chapter rather than from the TypeScript. Their canonical
//! form is the core's own §6.4.2 writer, so a case also proves that desktop's
//! tie-break string and the core's field-merge equality are the same string.
//! The committed JSON is the only input; nothing here recomputes an
//! expectation.

mod support;

use std::cmp::Ordering;

use memry_core::sync::field_merge::canonical_json;
use serde_json::{Map, Value as Json, json};
use support::vector_file;

/// `t` when it is a safe integer `>= 0`, else 0, as JavaScript reads it: `3.0`
/// and `1e3` are integers there.
fn version_of(value: &Json) -> u64 {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    match value.get("t").and_then(Json::as_f64) {
        Some(t) if t.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&t) => t as u64,
        _ => 0,
    }
}

/// Canonical strings compare by UTF-16 code units, JavaScript's string order.
fn compare(a: &Json, b: &Json) -> Ordering {
    version_of(a).cmp(&version_of(b)).then_with(|| {
        canonical_json(a)
            .encode_utf16()
            .cmp(canonical_json(b).encode_utf16())
    })
}

fn read_object(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| value.is_object())
}

fn read_map(value: Option<&Json>) -> Option<Map<String, Json>> {
    let entries = value?.as_object()?;
    Some(
        entries
            .iter()
            .filter(|(_, entry)| entry.is_object())
            .map(|(name, entry)| (name.clone(), entry.clone()))
            .collect(),
    )
}

fn entry_value(entry: Option<&Json>) -> Json {
    entry
        .and_then(|entry| entry.get("v"))
        .cloned()
        .unwrap_or(Json::Null)
}

/// `(value, remoteBehind, localChanged)`.
type Joined = (Option<Json>, bool, bool);

fn join_value(local: Option<&Json>, remote: Option<&Json>) -> Joined {
    let mine = read_object(local).cloned();
    if remote.is_some_and(Json::is_null) {
        return (mine, false, false);
    }
    let Some(theirs) = read_object(remote) else {
        let behind = mine.is_some();
        return (mine, behind, false);
    };
    let Some(mine) = mine else {
        return (Some(theirs.clone()), false, true);
    };
    match compare(&mine, theirs) {
        Ordering::Less => (Some(theirs.clone()), false, true),
        Ordering::Equal => (Some(mine), false, false),
        Ordering::Greater => (Some(mine), true, false),
    }
}

fn join_map(local: Option<&Json>, remote: Option<&Json>) -> Joined {
    let mine = read_map(local);
    if remote.is_some_and(Json::is_null) {
        return (mine.map(Json::Object), false, false);
    }
    let theirs = read_map(remote);
    if mine.is_none() && theirs.is_none() {
        return (None, false, false);
    }
    let empty = Map::new();
    let (ours_map, theirs_map) = (
        mine.as_ref().unwrap_or(&empty),
        theirs.as_ref().unwrap_or(&empty),
    );
    let mut joined = Map::new();
    let mut remote_behind = false;
    let mut local_changed = mine.is_none();
    for name in ours_map.keys().chain(
        theirs_map
            .keys()
            .filter(|name| !ours_map.contains_key(*name)),
    ) {
        let (ours, other) = (ours_map.get(name), theirs_map.get(name));
        let winner = match (ours, other) {
            (Some(ours), Some(other)) if compare(other, ours) == Ordering::Greater => other,
            (Some(ours), _) => ours,
            (None, Some(other)) => other,
            (None, None) => unreachable!("every name comes from one of the two maps"),
        };
        remote_behind |= other.is_none_or(|other| compare(winner, other) != Ordering::Equal);
        local_changed |= ours.is_none_or(|ours| compare(winner, ours) != Ordering::Equal);
        joined.insert(name.clone(), winner.clone());
    }
    (Some(Json::Object(joined)), remote_behind, local_changed)
}

fn stamp_map(stored: Option<&Json>, patch: &Map<String, Json>, clock_total: u64) -> Json {
    let mut next = read_map(stored).unwrap_or_default();
    let stamp = next.values().map(version_of).fold(clock_total, u64::max) + 1;
    for (name, value) in patch {
        if canonical_json(&entry_value(next.get(name))) == canonical_json(value) {
            continue;
        }
        let mut entry = next
            .get(name)
            .and_then(Json::as_object)
            .cloned()
            .unwrap_or_default();
        entry.insert("v".to_owned(), value.clone());
        entry.insert("t".to_owned(), json!(stamp));
        next.insert(name.clone(), Json::Object(entry));
    }
    Json::Object(next)
}

fn stamp_value(previous: Option<&Json>, edited: &Map<String, Json>) -> Json {
    let before = read_object(previous);
    let version = before.map_or(0, version_of);
    let mut content = edited.clone();
    content.shift_remove("t");
    let mut unchanged = content.clone();
    unchanged.insert("t".to_owned(), json!(version));
    if let Some(before) = before
        && canonical_json(&Json::Object(unchanged)) == canonical_json(before)
    {
        return before.clone();
    }
    content.insert("t".to_owned(), json!(version + 1));
    Json::Object(content)
}

fn plain(stored: Option<&Json>) -> Json {
    let values = read_map(stored)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, entry)| (name, entry_value(Some(&entry))))
        .filter(|(_, value)| !value.is_null())
        .collect();
    Json::Object(values)
}

fn sign(order: Ordering) -> i64 {
    match order {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

fn object<'a>(value: &'a Json, name: &str) -> &'a Map<String, Json> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{name}: expected a JSON object"))
}

fn check_join(name: &str, joined: Joined, swapped_value: Option<Json>, expected: &Json) {
    let (value, remote_behind, local_changed) = joined;
    assert_eq!(value.as_ref(), expected.get("value"), "{name}: value");
    assert_eq!(
        json!(remote_behind),
        expected["remoteBehind"],
        "{name}: remoteBehind"
    );
    assert_eq!(
        json!(local_changed),
        expected["localChanged"],
        "{name}: localChanged"
    );
    assert_eq!(
        canonical_json(&swapped_value.unwrap_or(Json::Null)),
        canonical_json(expected.get("value").unwrap_or(&Json::Null)),
        "{name}: the joined value is the same from either seat"
    );
}

#[test]
fn versioned_values_match_the_committed_vectors() {
    let file = vector_file("versioned-values");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("a case count")
    );

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let input = &case["input"];
        let expected = &case["expected"];
        let field = |key: &str| input.get(key);
        match case["kind"].as_str().expect("every case has a kind") {
            "canonical" => assert_eq!(
                json!(canonical_json(&input["value"])),
                expected["canonical"],
                "{name}"
            ),
            "order" => {
                assert_eq!(
                    json!(sign(compare(&input["a"], &input["b"]))),
                    expected["sign"],
                    "{name}"
                );
                assert_eq!(
                    sign(compare(&input["b"], &input["a"])),
                    -sign(compare(&input["a"], &input["b"])),
                    "{name}: the order is antisymmetric"
                );
            }
            "join-value" => check_join(
                name,
                join_value(field("local"), field("remote")),
                join_value(field("remote"), field("local")).0,
                expected,
            ),
            "join-map" => check_join(
                name,
                join_map(field("local"), field("remote")),
                join_map(field("remote"), field("local")).0,
                expected,
            ),
            "join-map-associativity" => {
                let ab = join_map(field("a"), field("b")).0;
                let left = join_map(ab.as_ref(), field("c")).0;
                let bc = join_map(field("b"), field("c")).0;
                let right = join_map(field("a"), bc.as_ref()).0;
                for (grouping, value) in [("(a ⊔ b) ⊔ c", left), ("a ⊔ (b ⊔ c)", right)] {
                    assert_eq!(
                        canonical_json(&value.unwrap_or(Json::Null)),
                        canonical_json(&expected["value"]),
                        "{name}: {grouping}"
                    );
                }
            }
            "stamp-map" => assert_eq!(
                stamp_map(
                    field("stored"),
                    object(&input["patch"], name),
                    input["clockTotal"].as_u64().expect("a clock total")
                ),
                expected["value"],
                "{name}"
            ),
            "stamp-value" => assert_eq!(
                stamp_value(field("previous"), object(&input["edited"], name)),
                expected["value"],
                "{name}"
            ),
            "plain" => assert_eq!(plain(field("stored")), expected["plain"], "{name}"),
            other => panic!("{name}: unknown case kind {other}"),
        }
    }
}
