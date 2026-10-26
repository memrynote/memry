//! The JSON spelling of a YAML value, as `apps/desktop/scripts/markdown-oracle/yaml-json.ts`
//! writes it: `{"$num"}`, `{"$date"}`, `{"$bin"}` and `{"$map"}` wrappers.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::markdown::frontmatter::{YamlMap, YamlValue};
use serde_json::{Map, Number, Value as Json};

use super::vector_compare::bytes_equal;

fn iso_to_ms(iso: &str) -> i64 {
    // `YYYY-MM-DDTHH:mm:ss.sssZ`, optionally with a signed six-digit year.
    let (sign, rest) = match iso.as_bytes()[0] {
        b'+' => (1, &iso[1..]),
        b'-' => (-1, &iso[1..]),
        _ => (1, iso),
    };
    let year_len = rest.find('-').expect("a year");
    let year = sign * rest[..year_len].parse::<i64>().expect("year");
    let number = |from: usize, len: usize| {
        rest[year_len + from..year_len + from + len]
            .parse::<i64>()
            .expect("digits")
    };
    let (month, day) = (number(1, 2), number(4, 2));
    let (hour, minute, second, ms) = (number(7, 2), number(10, 2), number(13, 2), number(16, 3));
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms
}

pub fn decode(json: &Json) -> YamlValue {
    match json {
        Json::Null => YamlValue::Null,
        Json::Bool(flag) => YamlValue::Bool(*flag),
        Json::Number(number) => YamlValue::Number(number.as_f64().expect("finite number")),
        Json::String(text) => YamlValue::String(text.clone()),
        Json::Array(items) => YamlValue::seq(items.iter().map(decode).collect()),
        Json::Object(map) => {
            if map.len() == 1 {
                let (key, body) = map.iter().next().expect("one entry");
                match (key.as_str(), body) {
                    ("$num", Json::String(kind)) => {
                        return YamlValue::Number(match kind.as_str() {
                            "NaN" => f64::NAN,
                            "Infinity" => f64::INFINITY,
                            "-Infinity" => f64::NEG_INFINITY,
                            "-0" => -0.0,
                            other => panic!("unknown $num {other}"),
                        });
                    }
                    ("$date", Json::String(iso)) => return YamlValue::Date(iso_to_ms(iso)),
                    ("$bin", Json::String(b64)) => {
                        return YamlValue::Binary(Arc::new(STANDARD.decode(b64).expect("base64")));
                    }
                    ("$map", Json::Object(inner)) => return YamlValue::map(decode_map(inner)),
                    _ => {}
                }
            }
            YamlValue::map(decode_map(map))
        }
    }
}

pub fn decode_map(map: &Map<String, Json>) -> YamlMap {
    let mut out = YamlMap::new();
    for (key, value) in map {
        out.insert(key.clone(), decode(value));
    }
    out
}

fn number_json(value: f64) -> Json {
    if value.is_finite() && !(value == 0.0 && value.is_sign_negative()) {
        return Json::Number(Number::from_f64(value).expect("finite"));
    }
    let kind = if value.is_nan() {
        "NaN"
    } else if value == f64::INFINITY {
        "Infinity"
    } else if value == f64::NEG_INFINITY {
        "-Infinity"
    } else {
        "-0"
    };
    Json::Object(Map::from_iter([(
        "$num".to_owned(),
        Json::String(kind.to_owned()),
    )]))
}

pub fn encode(value: &YamlValue) -> Json {
    match value {
        YamlValue::Null => Json::Null,
        YamlValue::Bool(flag) => Json::Bool(*flag),
        YamlValue::Number(number) => number_json(*number),
        YamlValue::String(text) => Json::String(text.clone()),
        YamlValue::Date(ms) => {
            // The oracle's own `toISOString` is the contract; reuse the dumper's.
            let dumped = memry_core::markdown::frontmatter::safe_dump(&YamlValue::Date(*ms))
                .expect("a date dumps");
            Json::Object(Map::from_iter([(
                "$date".to_owned(),
                Json::String(dumped.trim_end().to_owned()),
            )]))
        }
        YamlValue::Binary(bytes) => Json::Object(Map::from_iter([(
            "$bin".to_owned(),
            Json::String(STANDARD.encode(bytes.as_slice())),
        )])),
        YamlValue::Seq(items) => Json::Array(items.iter().map(encode).collect()),
        YamlValue::Map(map) => {
            let body: Map<String, Json> = map
                .iter()
                .map(|(key, item)| (key.to_owned(), encode(item)))
                .collect();
            if map.iter().any(|(key, _)| key.starts_with('$')) {
                Json::Object(Map::from_iter([("$map".to_owned(), Json::Object(body))]))
            } else {
                Json::Object(body)
            }
        }
    }
}

/// Date round trip guard: the decoded date must print as the text it came from.
pub fn dates_round_trip(iso: &str) -> Result<(), String> {
    let YamlValue::Date(ms) = decode(&serde_json::json!({ "$date": iso })) else {
        unreachable!()
    };
    let back = encode(&YamlValue::Date(ms));
    bytes_equal(iso, back["$date"].as_str().unwrap_or(""))
}
