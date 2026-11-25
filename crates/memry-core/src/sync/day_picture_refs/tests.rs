use super::*;

fn at(ticks: &[(&str, u64)]) -> VectorClock {
    ticks.iter().map(|(d, t)| ((*d).to_owned(), *t)).collect()
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

fn run(
    local: &[&str],
    remote: &[&str],
    sender: VectorClock,
    marks: &[(&str, bool, VectorClock)],
) -> Merged {
    let marks: Marks = marks
        .iter()
        .map(|(id, held, at)| ((*id).to_owned(), (*held, at.clone())))
        .collect();
    merge_lists(&ids(local), &ids(remote), &sender, &marks, |id| {
        Ok(id != "unresolvable")
    })
    .unwrap()
}

#[test]
fn a_picture_the_sender_never_saw_is_kept_and_pushed() {
    let merged = run(
        &["a"],
        &["b"],
        at(&[("B", 1)]),
        &[("a", true, at(&[("A", 1)]))],
    );
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["b", "a"])),
            push: true
        }
    );
}

#[test]
fn a_picture_the_sender_saw_and_removed_stays_removed() {
    // A pushed `a` at A:1; B pulled it, then removed it while A added `z`.
    let merged = run(
        &["a", "z"],
        &[],
        at(&[("A", 1), ("B", 1)]),
        &[("a", true, at(&[("A", 1)])), ("z", true, at(&[("A", 2)]))],
    );
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["z"])),
            push: true
        }
    );
}

#[test]
fn a_removal_the_sender_never_saw_stands_and_is_pushed() {
    let merged = run(
        &[],
        &["a", "b"],
        at(&[("A", 1), ("B", 1)]),
        &[("a", false, at(&[("A", 2)]))],
    );
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["b"])),
            push: true
        }
    );
}

#[test]
fn a_picture_the_sender_re_added_after_seeing_the_removal_is_taken() {
    let merged = run(
        &[],
        &["a"],
        at(&[("A", 2), ("B", 2)]),
        &[("a", false, at(&[("A", 2)]))],
    );
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["a"])),
            push: false
        }
    );
}

#[test]
fn an_unresolvable_picture_is_kept_but_never_pushed() {
    let merged = run(&["unresolvable"], &["b"], at(&[("B", 1)]), &[]);
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["b", "unresolvable"])),
            push: false
        }
    );
}

#[test]
fn equal_lists_push_nothing() {
    let merged = run(&["a", "b"], &["a", "b"], at(&[("B", 3)]), &[]);
    assert_eq!(
        merged,
        Merged {
            references: Some(ids(&["a", "b"])),
            push: false
        }
    );
}

#[test]
fn only_a_canonical_day_id_is_a_day_note() {
    assert!(is_day_note("j2026-06-09"));
    assert!(!is_day_note("j2026-02-30"));
    assert!(!is_day_note("vcpzueguep8y"));
}
