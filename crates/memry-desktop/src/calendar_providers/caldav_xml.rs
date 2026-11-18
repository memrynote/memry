//! The WebDAV `multistatus` answers CalDAV discovery reads, as tsdav's `davRequest` reads them
//! over xml-js (`tsdav/dist/tsdav.cjs.js:241-367`): namespace prefixes dropped, one entry per
//! `<response>`, its props merged from every `<propstat>` whose status is 2xx or absent, text
//! trimmed. Only the props discovery uses are kept.
//!
//! The body is a server's answer, so the reader is untrusted-input code: it streams (no
//! recursion), refuses nesting past [`MAX_DEPTH`], takes one step per XML event (at most one per
//! input byte) and keeps at most the input's text.

use quick_xml::Reader;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};

/// Deeper than any real multistatus (about 8); a document past it is not read.
pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum XmlError {
    #[error("the answer is not well-formed XML")]
    Malformed,
    #[error("the answer nests deeper than {MAX_DEPTH} elements")]
    TooDeep,
}

/// One `<prop>`'s values; `None` when no 2xx propstat carried the property.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DavProps {
    pub display_name: Option<String>,
    /// Local names inside `<resourcetype>` (`collection`, `calendar`).
    pub resource_types: Option<Vec<String>>,
    pub current_user_principal: Option<String>,
    pub calendar_home_set: Option<String>,
    pub calendar_color: Option<String>,
    pub calendar_timezone: Option<String>,
    pub getctag: Option<String>,
    pub sync_token: Option<String>,
    /// `<comp name>` values, upper-cased.
    pub components: Option<Vec<String>>,
    /// Local names inside each `<supported-report><report>`.
    pub reports: Option<Vec<String>>,
}

impl DavProps {
    /// `{ ...prev, ...curr.prop }`.
    fn merge(&mut self, next: Self) {
        macro_rules! take {
            ($($field:ident),*) => {$(if next.$field.is_some() { self.$field = next.$field; })*};
        }
        take!(
            display_name,
            resource_types,
            current_user_principal,
            calendar_home_set,
            calendar_color,
            calendar_timezone,
            getctag,
            sync_token,
            components,
            reports
        );
    }

    #[cfg(test)]
    pub fn text_len(&self) -> usize {
        let strings = [
            &self.display_name,
            &self.current_user_principal,
            &self.calendar_home_set,
            &self.calendar_color,
            &self.calendar_timezone,
            &self.getctag,
            &self.sync_token,
        ];
        let lists = [&self.resource_types, &self.components, &self.reports];
        strings
            .iter()
            .flat_map(|s| s.iter())
            .map(String::len)
            .sum::<usize>()
            + lists
                .iter()
                .flat_map(|l| l.iter().flatten())
                .map(String::len)
                .sum::<usize>()
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DavResponse {
    pub href: Option<String>,
    /// The `<status>` line's code; `None` when the response has none (the HTTP status applies).
    pub status: Option<u16>,
    pub props: DavProps,
}

thread_local! {
    static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Events read on this thread, for the complexity test.
#[cfg(test)]
pub fn steps() -> usize {
    STEPS.with(std::cell::Cell::get)
}

/// `parseStatusLine`: `HTTP/1.1 404 Not Found` gives 404.
fn status_code(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    parts.next()?;
    let code = parts.next()?;
    (code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit()))
        .then(|| code.parse().ok())
        .flatten()
}

fn local(name: &str) -> String {
    name.to_owned()
}

fn nonempty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[derive(Default)]
struct State {
    /// Open elements: local name and direct text.
    stack: Vec<(String, String)>,
    responses: Vec<DavResponse>,
    response: Option<DavResponse>,
    /// The open `<propstat>`: its props and status.
    propstat: Option<(DavProps, Option<u16>)>,
}

impl State {
    /// The local name `back` levels above the element being opened or closed.
    fn parent(&self, back: usize) -> &str {
        self.stack
            .len()
            .checked_sub(back)
            .and_then(|i| self.stack.get(i))
            .map_or("", |(name, _)| name.as_str())
    }

    fn props(&mut self) -> Option<&mut DavProps> {
        self.propstat.as_mut().map(|(props, _)| props)
    }

    fn open(&mut self, element: &BytesStart<'_>) -> Result<(), XmlError> {
        if self.stack.len() >= MAX_DEPTH {
            return Err(XmlError::TooDeep);
        }
        let name = local(element.local_name().as_ref());
        let (p1, p2, p3) = (
            self.parent(1).to_owned(),
            self.parent(2).to_owned(),
            self.parent(3).to_owned(),
        );
        match (p3.as_str(), p2.as_str(), p1.as_str(), name.as_str()) {
            (_, _, "multistatus", "response") => self.response = Some(DavResponse::default()),
            (_, _, "response", "propstat") => self.propstat = Some((DavProps::default(), None)),
            (_, _, "prop", "resourcetype") => {
                if let Some(p) = self.props() {
                    p.resource_types = Some(Vec::new());
                }
            }
            (_, _, "prop", "supported-calendar-component-set") => {
                if let Some(p) = self.props() {
                    p.components = Some(Vec::new());
                }
            }
            (_, _, "prop", "supported-report-set") => {
                if let Some(p) = self.props() {
                    p.reports = Some(Vec::new());
                }
            }
            (_, "prop", "resourcetype", _) => {
                if let Some(Some(types)) = self.props().map(|p| p.resource_types.as_mut()) {
                    types.push(name.clone());
                }
            }
            (_, "prop", "supported-calendar-component-set", "comp") => {
                let comp = element
                    .attributes()
                    .flatten()
                    .find(|a| a.key.local_name().as_ref() == "name")
                    .map(|a| local(&a.value).to_ascii_uppercase());
                if let (Some(comp), Some(Some(list))) =
                    (comp, self.props().map(|p| p.components.as_mut()))
                {
                    list.push(comp);
                }
            }
            ("supported-report-set", "supported-report", "report", _) => {
                if let Some(Some(list)) = self.props().map(|p| p.reports.as_mut()) {
                    list.push(name.clone());
                }
            }
            _ => {}
        }
        self.stack.push((name, String::new()));
        Ok(())
    }

    fn close(&mut self) {
        let Some((name, text)) = self.stack.pop() else {
            return;
        };
        let (p1, p2) = (self.parent(1).to_owned(), self.parent(2).to_owned());
        match (p2.as_str(), p1.as_str(), name.as_str()) {
            (_, "multistatus", "response") => {
                if let Some(response) = self.response.take() {
                    self.responses.push(response);
                }
            }
            (_, "response", "href") => {
                if let Some(response) = self.response.as_mut()
                    && response.href.is_none()
                {
                    response.href = nonempty(&text);
                }
            }
            (_, "response", "status") => {
                if let Some(response) = self.response.as_mut() {
                    response.status = status_code(&text);
                }
            }
            (_, "response", "propstat") => {
                if let (Some((props, status)), Some(response)) =
                    (self.propstat.take(), self.response.as_mut())
                    && status.is_none_or(|s| (200..300).contains(&s))
                {
                    response.props.merge(props);
                }
            }
            (_, "propstat", "status") => {
                if let Some((_, status)) = self.propstat.as_mut() {
                    *status = status_code(&text);
                }
            }
            (_, "prop", field) => {
                let value = nonempty(&text);
                if let Some(props) = self.props() {
                    let slot = match field {
                        "displayname" => &mut props.display_name,
                        "calendar-color" => &mut props.calendar_color,
                        "calendar-timezone" => &mut props.calendar_timezone,
                        "getctag" => &mut props.getctag,
                        "sync-token" => &mut props.sync_token,
                        _ => return,
                    };
                    *slot = value;
                }
            }
            ("prop", "current-user-principal" | "calendar-home-set", "href") => {
                let value = nonempty(&text);
                if let Some(props) = self.props() {
                    let slot = if p1 == "current-user-principal" {
                        &mut props.current_user_principal
                    } else {
                        &mut props.calendar_home_set
                    };
                    if slot.is_none() {
                        *slot = value;
                    }
                }
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        if let Some((_, buffer)) = self.stack.last_mut() {
            buffer.push_str(text);
        }
    }
}

/// The `<response>` entries of a `multistatus` document; `Ok(None)` when the root element is
/// something else (tsdav then reports the HTTP response alone).
pub fn parse_multistatus(body: &str) -> Result<Option<Vec<DavResponse>>, XmlError> {
    let mut reader = Reader::from_str(body);
    let mut state = State::default();
    let mut rooted = None;
    loop {
        STEPS.with(|s| s.set(s.get() + 1));
        let event = reader.read_event().map_err(|_| XmlError::Malformed)?;
        if rooted.is_none()
            && let Event::Start(e) | Event::Empty(e) = &event
        {
            rooted = Some(e.local_name().as_ref() == "multistatus");
        }
        match event {
            Event::Start(e) => state.open(&e)?,
            Event::Empty(e) => {
                state.open(&e)?;
                state.close();
            }
            Event::End(_) => state.close(),
            Event::Text(t) => state.text(&t.xml10_content()),
            Event::CData(t) => state.text(&t.xml10_content()),
            Event::GeneralRef(r) => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    Ok(None) => resolve_predefined_entity(&r.xml10_content())
                        .ok_or(XmlError::Malformed)?
                        .to_owned(),
                    Err(_) => return Err(XmlError::Malformed),
                };
                state.text(&resolved);
            }
            Event::Eof => break,
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }
    if !state.stack.is_empty() {
        return Err(XmlError::Malformed);
    }
    match rooted {
        Some(true) => Ok(Some(state.responses)),
        _ => Ok(None),
    }
}

#[cfg(test)]
#[path = "caldav_xml_tests.rs"]
mod tests;
