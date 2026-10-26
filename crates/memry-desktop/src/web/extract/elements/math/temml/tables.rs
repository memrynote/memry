//! The data tables of temml, generated into `tables.json` by
//! `packages/article-extract/scripts/vectors/temml-tables.mjs`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::Value;

pub struct Symbol {
    pub group: String,
    pub replace: Option<String>,
}

pub struct Tables {
    pub symbols_math: HashMap<String, Symbol>,
    pub symbols_text: HashMap<String, Symbol>,
    pub atoms: HashSet<String>,
    pub non_atoms: HashSet<String>,
    pub ligatures: HashSet<String>,
    pub unicode_symbols: HashMap<String, String>,
    /// Unicode sub/superscript character -> (ASCII character, is a subscript).
    pub u_subs_and_sups: HashMap<String, (String, bool)>,
    pub ascii_from_script: HashMap<String, String>,
    pub smalls: String,
    pub macros: HashMap<String, String>,
}

fn s(v: &Value) -> String {
    v.as_str().expect("string").to_string()
}

fn pairs(root: &Value, name: &str) -> HashMap<String, String> {
    root[name]
        .as_array()
        .expect("pairs")
        .iter()
        .map(|p| (s(&p[0]), s(&p[1])))
        .collect()
}

fn symbols(root: &Value, mode: &str) -> HashMap<String, Symbol> {
    root["symbols"][mode]
        .as_array()
        .expect("symbols")
        .iter()
        .map(|e| {
            (
                s(&e[0]),
                Symbol {
                    group: s(&e[1]),
                    replace: e[2].as_str().map(str::to_string),
                },
            )
        })
        .collect()
}

fn set(root: &Value, name: &str) -> HashSet<String> {
    root[name].as_array().expect("set").iter().map(s).collect()
}

static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let root: Value = serde_json::from_str(include_str!("tables.json")).expect("temml tables");
    Tables {
        symbols_math: symbols(&root, "math"),
        symbols_text: symbols(&root, "text"),
        atoms: set(&root, "atoms"),
        non_atoms: set(&root, "nonAtoms"),
        ligatures: set(&root, "ligatures"),
        unicode_symbols: pairs(&root, "unicodeSymbols"),
        u_subs_and_sups: root["uSubsAndSups"]
            .as_array()
            .expect("sups")
            .iter()
            .map(|e| (s(&e[0]), (s(&e[1]), e[2].as_bool().expect("bool"))))
            .collect(),
        ascii_from_script: pairs(&root, "asciiFromScript"),
        smalls: s(&root["smalls"]),
        macros: pairs(&root, "macros"),
    }
});

pub fn tables() -> &'static Tables {
    &TABLES
}

pub fn symbol(mode: &str, name: &str) -> Option<&'static Symbol> {
    let t = tables();
    if mode == "math" {
        t.symbols_math.get(name)
    } else {
        t.symbols_text.get(name)
    }
}
