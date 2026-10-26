//! `i18n-format.json.gz`: the real `createMainI18n` output for every message of the four native
//! namespaces in every locale, plus hand-written parser corners. Zero mismatches allowed.

use std::io::Read;

use flate2::read::GzDecoder;
use memry_desktop::i18n::{Arg, Args, format_message, keys, locales, t};
use serde_json::Value;

fn vectors() -> Value {
    let mut text = String::new();
    GzDecoder::new(&include_bytes!("vectors/i18n-format.json.gz")[..])
        .read_to_string(&mut text)
        .expect("gunzip");
    serde_json::from_str(&text).expect("json")
}

fn arg(value: &Value) -> Arg {
    match value {
        Value::String(text) => Arg::Str(text.clone()),
        other => Arg::Num(other.as_f64().expect("a number")),
    }
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v.as_str().expect("str"))
        .collect()
}

/// The argument sets of the generator: counts then the extra texts when the message has a
/// plural argument, the texts alone when it has only plain ones, one empty set otherwise.
fn sets(names: &Value, meta: &Value) -> Vec<(f64, String)> {
    let plain = strings(&names["plain"]);
    let plural = strings(&names["plural"]);
    let counts: Vec<f64> = meta["counts"]
        .as_array()
        .expect("counts")
        .iter()
        .map(|c| c.as_f64().expect("n"))
        .collect();
    let texts = strings(&meta["texts"]);
    if plain.is_empty() && plural.is_empty() {
        vec![(0.0, String::new())]
    } else if !plural.is_empty() {
        counts
            .iter()
            .map(|c| (*c, texts[0].to_owned()))
            .chain(texts[1..].iter().map(|t| (2.0, (*t).to_owned())))
            .collect()
    } else {
        texts.iter().map(|t| (0.0, (*t).to_owned())).collect()
    }
}

fn args_for(names: &Value, set: &(f64, String)) -> Args {
    let mut args = Args::new();
    for name in strings(&names["plain"]) {
        args.insert(name.to_owned(), Arg::Str(set.1.clone()));
    }
    for name in strings(&names["plural"]) {
        args.insert(name.to_owned(), Arg::Num(set.0));
    }
    args
}

#[test]
fn i18n_vectors() {
    let file = vectors();
    let mut mismatches = Vec::new();
    let mut checked = 0usize;

    for case in file["cases"].as_array().expect("cases") {
        let args: Args = case["args"]
            .as_object()
            .expect("args")
            .iter()
            .map(|(k, v)| (k.clone(), arg(v)))
            .collect();
        let got = format_message(
            case["template"].as_str().expect("template"),
            case["locale"].as_str().expect("locale"),
            &args,
        );
        if case["expected"] != Value::String(got.clone()) {
            mismatches.push(format!(
                "template {:?} [{}] {:?}\n  want {}\n  got  {got:?}",
                case["template"], case["locale"], case["args"], case["expected"]
            ));
        }
        checked += 1;
    }

    for missing in file["missing"].as_array().expect("missing") {
        let got = t("en", missing["key"].as_str().expect("key"), &Args::new());
        if missing["expected"] != Value::String(got.clone()) {
            mismatches.push(format!("missing {}: {got:?}", missing["key"]));
        }
        checked += 1;
    }

    let all_locales: Vec<&str> = locales().collect();
    assert_eq!(
        all_locales.len(),
        32,
        "every locale is embedded: {all_locales:?}"
    );
    let english = keys("en");
    for locale in all_locales {
        let recorded = file["messages"][locale]
            .as_object()
            .unwrap_or_else(|| panic!("{locale} has no vectors"));
        let mut union: Vec<&str> = english.iter().copied().chain(keys(locale)).collect();
        union.sort_unstable();
        union.dedup();
        for key in union {
            match recorded.get(key) {
                Some(entry) => {
                    for (set, want) in sets(&entry["names"], &file["meta"])
                        .iter()
                        .zip(strings(&entry["out"]))
                    {
                        let got = t(locale, key, &args_for(&entry["names"], set));
                        if got != want {
                            mismatches.push(format!(
                                "{locale} {key} {set:?}\n  want {want:?}\n  got  {got:?}"
                            ));
                        }
                        checked += 1;
                    }
                }
                // Unrecorded: no arguments, and it formats to its own template.
                None => {
                    let got = t(locale, key, &Args::new());
                    let template = memry_desktop::i18n::raw(locale, key).expect("template");
                    if got != template {
                        mismatches.push(format!("{locale} {key}: {got:?} != {template:?}"));
                    }
                    checked += 1;
                }
            }
        }
    }

    assert!(checked > 50_000, "only {checked} cases ran");
    assert!(
        mismatches.is_empty(),
        "{} mismatches of {checked}; first:\n{}",
        mismatches.len(),
        mismatches
            .iter()
            .take(25)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
