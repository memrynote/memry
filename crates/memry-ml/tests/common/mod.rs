//! Helpers shared by the vector tests of `packages/contracts/test-vectors/`. Each test binary uses
//! a part of them.

#![allow(dead_code)]

pub mod audio;
pub mod image;

use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A vector file of `packages/contracts/test-vectors/`.
pub fn vectors(file: &str) -> Value {
    let path = root().join("packages/contracts/test-vectors").join(file);
    serde_json::from_slice(&std::fs::read(path).expect(file)).expect("valid JSON")
}

pub fn floats(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("numbers")
        .iter()
        .map(|v| v.as_f64().expect("a number") as f32)
        .collect()
}

pub fn ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .expect("tokenIds")
        .iter()
        .map(|id| id.as_i64().expect("an integer id"))
        .collect()
}

/// The dot product in f64: the cosine of two stored vectors, which are unit length.
pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}
