//! A CalDAV account behind [`super::serve`]: principal, calendar home and collections under one
//! path prefix, behind Basic or Digest auth (the server checks the Digest response it gets), and
//! an in-memory keychain standing in for the OS one.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use md5::{Digest, Md5};
use memry_core::api::errors::SecureStoreError;
use memry_desktop::seams::secure_store::GenericSecrets;

use super::{Reply, Seen};

pub enum Auth {
    Basic,
    /// One realm and nonce for the life of the server.
    Digest,
}

pub struct Collection {
    pub name: &'static str,
    pub title: &'static str,
    pub components: &'static [&'static str],
}

impl Collection {
    pub fn events(name: &'static str, title: &'static str) -> Self {
        Self {
            name,
            title,
            components: &["VEVENT"],
        }
    }

    /// A task list: a calendar collection that cannot hold events.
    pub fn tasks(name: &'static str, title: &'static str) -> Self {
        Self {
            name,
            title,
            components: &["VTODO"],
        }
    }
}

pub struct Dav {
    /// `/<prefix>/` is the root, `principal/` and `calendars/` sit under it.
    pub prefix: &'static str,
    pub username: &'static str,
    pub pass: &'static str,
    pub auth: Auth,
    pub collections: Mutex<Vec<Collection>>,
}

pub const REALM: &str = "dav";
pub const NONCE: &str = "nonce-1";

pub fn basic_header(username: &str, pass: &str) -> String {
    let pair = format!("{username}:{pass}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )
}

fn md5(text: &str) -> String {
    hex::encode(Md5::digest(text.as_bytes()))
}

/// `key="value"` and `key=value` pairs of a Digest header.
fn digest_params(header: &str) -> HashMap<String, String> {
    header
        .trim_start_matches("Digest ")
        .split(", ")
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.trim_matches('"').to_owned()))
        .collect()
}

const NAMESPACES: &str = r#"xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/""#;

fn response(href: &str, props: &str) -> String {
    format!(
        "<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop>\
         <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    )
}

fn multistatus(responses: &str) -> Reply {
    Reply::multistatus(format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus {NAMESPACES}>{responses}</d:multistatus>"
    ))
}

impl Dav {
    pub fn new(
        prefix: &'static str,
        username: &'static str,
        pass: &'static str,
        auth: Auth,
        collections: Vec<Collection>,
    ) -> Self {
        Self {
            prefix,
            username,
            pass,
            auth,
            collections: Mutex::new(collections),
        }
    }

    pub fn set_collections(&self, collections: Vec<Collection>) {
        *self.collections.lock().unwrap() = collections;
    }

    fn authorized(&self, seen: &Seen) -> bool {
        let Some(header) = seen.authorization.as_deref() else {
            return false;
        };
        match self.auth {
            Auth::Basic => header == basic_header(self.username, self.pass),
            Auth::Digest => {
                let p = digest_params(header);
                let get = |k: &str| p.get(k).map(String::as_str).unwrap_or_default();
                let ha1 = md5(&format!("{}:{REALM}:{}", self.username, self.pass));
                let ha2 = md5(&format!("{}:{}", seen.method, get("uri")));
                let expected = md5(&format!(
                    "{ha1}:{NONCE}:{}:{}:auth:{ha2}",
                    get("nc"),
                    get("cnonce")
                ));
                header.starts_with("Digest ")
                    && get("username") == self.username
                    && get("nonce") == NONCE
                    && get("uri") == seen.target
                    && get("response") == expected
            }
        }
    }

    fn challenge(&self) -> Reply {
        let value = match self.auth {
            Auth::Basic => format!("Basic realm=\"{REALM}\""),
            Auth::Digest => {
                format!("Digest realm=\"{REALM}\", qop=\"auth\", nonce=\"{NONCE}\", algorithm=MD5")
            }
        };
        Reply::status(401).with_header("www-authenticate", &value)
    }

    /// The account's answer to one request; 404 for anything else.
    pub fn answer(&self, seen: &Seen) -> Reply {
        if !self.authorized(seen) {
            return self.challenge();
        }
        let prefix = self.prefix;
        let principal = format!("{prefix}/principal/");
        let home = format!("{prefix}/calendars/");
        if seen.method != "PROPFIND" {
            return Reply::status(404);
        }
        if seen.target == format!("{prefix}/") && seen.body.contains("current-user-principal") {
            let props = format!(
                "<d:current-user-principal><d:href>{principal}</d:href></d:current-user-principal>"
            );
            return multistatus(&response(&seen.target, &props));
        }
        if seen.target == principal {
            let props =
                format!("<c:calendar-home-set><d:href>{home}</d:href></c:calendar-home-set>");
            return multistatus(&response(&principal, &props));
        }
        if seen.target == home && seen.depth.as_deref() == Some("1") {
            let mut listing = response(&home, "<d:resourcetype><d:collection/></d:resourcetype>");
            for c in self.collections.lock().unwrap().iter() {
                let comps = c
                    .components
                    .iter()
                    .map(|name| format!("<c:comp name=\"{name}\"/>"))
                    .collect::<String>();
                listing.push_str(&response(
                    &format!("{home}{}/", c.name),
                    &format!(
                        "<d:displayname>{}</d:displayname>\
                         <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>\
                         <ca:calendar-color>#FF2968FF</ca:calendar-color><cs:getctag>1</cs:getctag>\
                         <c:supported-calendar-component-set>{comps}</c:supported-calendar-component-set>",
                        c.title
                    ),
                ));
            }
            return multistatus(&listing);
        }
        Reply::status(404)
    }
}

/// What a [`Secrets`] runs once, after its next write.
pub type AfterSet = Box<dyn FnOnce() + Send>;

/// The OS keychain's stand-in: `(service, account)` to bytes, and a step to run after the next
/// write.
#[derive(Default)]
pub struct Secrets(
    pub Mutex<HashMap<(String, String), Vec<u8>>>,
    pub Mutex<Option<AfterSet>>,
);

impl Secrets {
    pub fn get(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl GenericSecrets for Secrets {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.get(service, account))
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .unwrap()
            .insert((service.to_owned(), account.to_owned()), value.to_vec());
        if let Some(after) = self.1.lock().unwrap().take() {
            after();
        }
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}
