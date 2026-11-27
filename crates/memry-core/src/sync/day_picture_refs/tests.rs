use super::*;

fn lists(live: &[&str], removed: &[&str]) -> Lists {
    let own = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect();
    Lists {
        live: own(live),
        removed: own(removed),
    }
}

#[test]
fn a_picture_the_sender_never_named_is_kept() {
    let joined = Lists::join(&lists(&["a"], &[]), &lists(&["b"], &[]));
    assert_eq!(joined, lists(&["a", "b"], &[]));
    assert!(
        !joined.within(&lists(&["b"], &[])),
        "the sender is owed `a`"
    );
}

#[test]
fn a_removal_the_sender_carries_stands() {
    let joined = Lists::join(&lists(&["a", "z"], &[]), &lists(&[], &["a"]));
    assert_eq!(joined, lists(&["z"], &["a"]));
}

#[test]
fn a_removal_of_this_device_stands_against_a_list_that_names_it() {
    let sent = lists(&["a", "b"], &[]);
    let joined = Lists::join(&lists(&["b"], &["a"]), &sent);
    assert_eq!(joined, lists(&["b"], &["a"]));
    assert!(!joined.within(&sent), "the sender is owed the removal");
}

#[test]
fn equal_states_owe_nothing() {
    let held = lists(&["a", "b"], &["c"]);
    let joined = Lists::join(&held, &lists(&["b", "a"], &["c"]));
    assert!(joined.same(&held));
    assert!(joined.within(&lists(&["b", "a"], &["c"])));
}

#[test]
fn only_a_canonical_day_id_is_a_day_note() {
    assert!(is_day_note("j2026-06-09"));
    assert!(!is_day_note("j2026-02-30"));
    assert!(!is_day_note("vcpzueguep8y"));
}
