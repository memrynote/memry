//! The calendar objects behind [`super::dav::Dav`]: one versioned store answering the object
//! requests a pull and a push make (calendar-query, calendar-multiget, sync-collection, the ctag
//! PROPFIND, GET, PUT and DELETE), with ETags and `If-Match`/`If-None-Match` as RFC 4791 and
//! RFC 6578 describe them. Every change bumps one version, which is the ctag, the ETag of the
//! object it wrote and the sync token.

use std::collections::BTreeMap;
use std::sync::Mutex;

use super::{Reply, Seen};

#[derive(Default)]
struct State {
    version: u64,
    /// Path to `(etag, data)`.
    objects: BTreeMap<String, (String, String)>,
    /// `(version, path, deleted)`, for sync-collection.
    log: Vec<(u64, String, bool)>,
    /// Tokens older than this are refused (`valid-sync-token`).
    floor: u64,
}

#[derive(Default)]
pub struct Store(Mutex<State>);

const NAMESPACES: &str = r#"xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/""#;

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn object_response(path: &str, etag: &str, data: Option<&str>) -> String {
    let data = data
        .map(|d| format!("<c:calendar-data>{}</c:calendar-data>", escape(d)))
        .unwrap_or_default();
    format!(
        "<d:response><d:href>{path}</d:href><d:propstat><d:prop><d:getetag>{}</d:getetag>{data}\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
        escape(etag)
    )
}

fn gone_response(path: &str) -> String {
    format!(
        "<d:response><d:href>{path}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>"
    )
}

fn multistatus(responses: &str, token: Option<u64>) -> Reply {
    let token = token
        .map(|v| format!("<d:sync-token>tok-{v}</d:sync-token>"))
        .unwrap_or_default();
    Reply::multistatus(format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus {NAMESPACES}>{responses}{token}</d:multistatus>"
    ))
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    text.split(open)
        .skip(1)
        .filter_map(|part| part.split_once(close).map(|(inside, _)| inside))
        .collect()
}

impl State {
    fn write(&mut self, path: &str, data: Option<&str>) -> String {
        self.version += 1;
        let etag = format!("\"e{}\"", self.version);
        match data {
            Some(data) => {
                self.objects
                    .insert(path.to_owned(), (etag.clone(), data.to_owned()));
            }
            None => {
                self.objects.remove(path);
            }
        }
        self.log
            .push((self.version, path.to_owned(), data.is_none()));
        etag
    }

    fn members(&self, collection: &str) -> impl Iterator<Item = (&String, &(String, String))> {
        self.objects
            .iter()
            .filter(move |(path, _)| path.starts_with(collection))
    }
}

impl Store {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }

    /// A change made on the server (another client): the new ETag.
    pub fn put_remote(&self, path: &str, data: &str) -> String {
        self.state().write(path, Some(data))
    }

    /// An object deleted on the server.
    pub fn delete_remote(&self, path: &str) {
        self.state().write(path, None);
    }

    pub fn object(&self, path: &str) -> Option<(String, String)> {
        self.state().objects.get(path).cloned()
    }

    pub fn paths(&self) -> Vec<String> {
        self.state().objects.keys().cloned().collect()
    }

    /// Every sync token handed out so far stops being valid.
    pub fn expire_tokens(&self) {
        let mut state = self.state();
        state.floor = state.version + 1;
    }

    /// The answer for a request on `collection` (a path ending in `/`) or one of its objects;
    /// `None` for anything else.
    pub fn answer(&self, seen: &Seen, collection: &str) -> Option<Reply> {
        let mut state = self.state();
        let target = seen.target.as_str();
        if target == collection {
            return Some(match seen.method.as_str() {
                "PROPFIND" if seen.body.contains("getctag") => {
                    let props = format!(
                        "<cs:getctag>{0}</cs:getctag><d:sync-token>tok-{0}</d:sync-token>",
                        state.version
                    );
                    multistatus(
                        &format!(
                            "<d:response><d:href>{collection}</d:href><d:propstat><d:prop>{props}\
                             </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                        ),
                        None,
                    )
                }
                "REPORT" if seen.body.contains("calendar-query") => {
                    let all: String = state
                        .members(collection)
                        .map(|(path, (etag, data))| object_response(path, etag, Some(data)))
                        .collect();
                    multistatus(&all, None)
                }
                "REPORT" if seen.body.contains("calendar-multiget") => {
                    let found: String = between(&seen.body, "<d:href>", "</d:href>")
                        .into_iter()
                        .map(|path| match state.objects.get(path) {
                            Some((etag, data)) => object_response(path, etag, Some(data)),
                            None => gone_response(path),
                        })
                        .collect();
                    multistatus(&found, None)
                }
                "REPORT" if seen.body.contains("sync-collection") => {
                    let token = between(&seen.body, "<d:sync-token>", "</d:sync-token>")
                        .first()
                        .copied()
                        .unwrap_or_default();
                    let since = if token.is_empty() {
                        None
                    } else {
                        match token
                            .strip_prefix("tok-")
                            .and_then(|v| v.parse::<u64>().ok())
                        {
                            Some(v) if v >= state.floor => Some(v),
                            _ => {
                                return Some(Reply::Ok {
                                    status: 403,
                                    headers: Vec::new(),
                                    body:
                                        b"<d:error xmlns:d=\"DAV:\"><d:valid-sync-token/></d:error>"
                                            .to_vec(),
                                });
                            }
                        }
                    };
                    let responses: String = match since {
                        None => state
                            .members(collection)
                            .map(|(path, (etag, _))| object_response(path, etag, None))
                            .collect(),
                        Some(since) => {
                            let mut latest: BTreeMap<&str, bool> = BTreeMap::new();
                            for (version, path, deleted) in &state.log {
                                if *version > since && path.starts_with(collection) {
                                    latest.insert(path, *deleted);
                                }
                            }
                            latest
                                .into_iter()
                                .map(|(path, deleted)| match state.objects.get(path) {
                                    Some((etag, _)) if !deleted => {
                                        object_response(path, etag, None)
                                    }
                                    _ => gone_response(path),
                                })
                                .collect()
                        }
                    };
                    multistatus(&responses, Some(state.version))
                }
                _ => Reply::status(405),
            });
        }
        if !target.starts_with(collection) {
            return None;
        }
        let current = state.objects.get(target).cloned();
        let matches = |wanted: &str| match &current {
            Some((etag, _)) => wanted == "*" || wanted == etag,
            None => false,
        };
        Some(match seen.method.as_str() {
            "GET" => match current {
                Some((etag, data)) => Reply::Ok {
                    status: 200,
                    headers: vec![("etag", etag)],
                    body: data.into_bytes(),
                },
                None => Reply::status(404),
            },
            "PUT" => {
                if seen.if_none_match.as_deref() == Some("*") && current.is_some()
                    || seen.if_match.as_deref().is_some_and(|m| !matches(m))
                {
                    return Some(Reply::status(412));
                }
                let created = current.is_none();
                let etag = state.write(target, Some(&seen.body));
                Reply::status(if created { 201 } else { 204 }).with_header("etag", &etag)
            }
            "DELETE" => {
                if current.is_none() {
                    Reply::status(404)
                } else if seen.if_match.as_deref().is_some_and(|m| !matches(m)) {
                    Reply::status(412)
                } else {
                    state.write(target, None);
                    Reply::status(204)
                }
            }
            _ => Reply::status(405),
        })
    }
}
