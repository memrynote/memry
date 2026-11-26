//! `liftImagesOutOfTextBlocks` (`editor-schema/src/lift-images.ts`): an image
//! in a top-level paragraph or heading moves out of it, into an image block
//! right after it. The source runs its `IMAGE` regex over the block's HTML;
//! this port walks the same HTML as a sequence of events, so "the characters
//! next to `<img>`" are the neighbouring text events.

use crate::domain::journal_rules::is_js_whitespace;

use super::inline::{Html, Tag};
use super::media::Media;

#[derive(Debug, Clone)]
enum Event {
    /// Source text, which a later match may still take spaces from.
    Text(String),
    /// Text a replacement wrote, which no later match reads.
    Kept(String),
    Open(Opener),
    Close,
    Br,
    Code(String),
    Media(Media),
}

#[derive(Debug, Clone)]
enum Opener {
    Wrap(Tag),
    Link(String),
}

/// The block's content with its images taken out, and the images in order;
/// `None` when the source leaves the block alone (`splitImagesOut` returns
/// null): no `<img>` in it, or a paragraph (`lift_when_alone` false) holding
/// nothing but images.
pub(super) fn lift_images(html: &[Html], lift_when_alone: bool) -> Option<(Vec<Html>, Vec<Media>)> {
    let mut events = Vec::new();
    flatten(html, &mut events);
    let is_image = |event: &Event| matches!(event, Event::Media(Media::Image { .. }));
    if !events.iter().any(is_image) {
        return None;
    }
    let holds_text = events.iter().any(|event| match event {
        Event::Text(text) | Event::Code(text) => text.chars().any(|c| !is_js_whitespace(c)),
        _ => false,
    });
    if !lift_when_alone && !holds_text {
        return None;
    }

    let total = events.len();
    let at_start = |index: usize, events: &[Event]| {
        index == 0 || (index == 1 && matches!(&events[0], Event::Text(text) if spaces_only(text)))
    };
    let at_end = |end: usize, events: &[Event]| {
        end == total
            || (end + 1 == total
                && matches!(&events[total - 1], Event::Text(text) if spaces_only(text)))
    };

    let original = events.clone();
    let mut out: Vec<Event> = Vec::new();
    let mut images = Vec::new();
    let mut index = 0;
    while index < events.len() {
        let matched = match &events[index] {
            Event::Open(Opener::Link(href)) => linked_image(&events, index).map(|(image, end)| {
                let label = match &image {
                    Media::Image { alt, .. } if !alt.is_empty() => alt.clone(),
                    _ => href.clone(),
                };
                let mut replacement = Vec::new();
                if !label.is_empty() {
                    replacement.push(Event::Open(Opener::Link(href.clone())));
                    replacement.push(Event::Kept(label));
                    replacement.push(Event::Close);
                }
                (image, end, Some(replacement))
            }),
            Event::Media(image @ Media::Image { .. }) => Some((image.clone(), index + 1, None)),
            _ => None,
        };
        let Some((image, end, linked)) = matched else {
            out.push(events[index].clone());
            index += 1;
            continue;
        };
        let before = take_trailing_spaces(&mut out);
        let after = take_leading_spaces(&mut events, end);
        let edge = at_start(index, &original) || at_end(end, &original);
        images.push(image);
        match linked {
            Some(replacement) => {
                out.push(Event::Kept(before));
                out.extend(replacement);
                out.push(Event::Kept(after));
            }
            None if !edge && !(before.is_empty() && after.is_empty()) => {
                out.push(Event::Kept(" ".to_owned()));
            }
            None => {}
        }
        index = end;
    }
    Some((rebuild(out), images))
}

/// `<a …>\s*<img …>\s*</a>`: the image and the index after the `</a>`.
fn linked_image(events: &[Event], open: usize) -> Option<(Media, usize)> {
    let whitespace = |event: Option<&Event>| matches!(event, Some(Event::Text(text)) if text.chars().all(is_js_whitespace));
    let mut at = open + 1;
    if whitespace(events.get(at)) {
        at += 1;
    }
    let Some(Event::Media(image @ Media::Image { .. })) = events.get(at) else {
        return None;
    };
    at += 1;
    if whitespace(events.get(at)) {
        at += 1;
    }
    matches!(events.get(at), Some(Event::Close)).then(|| (image.clone(), at + 1))
}

fn spaces_only(text: &str) -> bool {
    text.chars().all(|c| matches!(c, ' ' | '\t'))
}

/// `([ \t]*)` before the match: taken from the source text right before it.
fn take_trailing_spaces(out: &mut [Event]) -> String {
    let Some(Event::Text(text)) = out.last_mut() else {
        return String::new();
    };
    let kept = text.trim_end_matches([' ', '\t']).len();
    let spaces = text[kept..].to_owned();
    text.truncate(kept);
    spaces
}

/// `([ \t]*)` after the match: taken from the source text right after it.
fn take_leading_spaces(events: &mut [Event], at: usize) -> String {
    let Some(Event::Text(text)) = events.get_mut(at) else {
        return String::new();
    };
    let rest = text.trim_start_matches([' ', '\t']).to_owned();
    let spaces = text[..text.len() - rest.len()].to_owned();
    *text = rest;
    spaces
}

fn flatten(nodes: &[Html], out: &mut Vec<Event>) {
    for node in nodes {
        match node {
            Html::Text(text) => out.push(Event::Text(text.clone())),
            Html::Br => out.push(Event::Br),
            Html::Code(code) => out.push(Event::Code(code.clone())),
            Html::Media(media) => out.push(Event::Media(media.clone())),
            Html::Wrap(tag, children) => {
                out.push(Event::Open(Opener::Wrap(*tag)));
                flatten(children, out);
                out.push(Event::Close);
            }
            Html::Link { href, children } => {
                out.push(Event::Open(Opener::Link(href.clone())));
                flatten(children, out);
                out.push(Event::Close);
            }
        }
    }
}

/// The events back to a tree, adjacent text joined into one node as the
/// browser's parse of the rewritten HTML joins it.
fn rebuild(events: Vec<Event>) -> Vec<Html> {
    let mut stack: Vec<(Option<Opener>, Vec<Html>)> = vec![(None, Vec::new())];
    for event in events {
        let top = &mut stack.last_mut().expect("the root level").1;
        match event {
            Event::Text(text) | Event::Kept(text) => {
                if text.is_empty() {
                    continue;
                }
                match top.last_mut() {
                    Some(Html::Text(last)) => last.push_str(&text),
                    _ => top.push(Html::Text(text)),
                }
            }
            Event::Br => top.push(Html::Br),
            Event::Code(code) => top.push(Html::Code(code)),
            Event::Media(media) => top.push(Html::Media(media)),
            Event::Open(opener) => stack.push((Some(opener), Vec::new())),
            Event::Close => {
                let (opener, children) = stack.pop().expect("balanced events");
                let node = match opener.expect("a close has an open") {
                    Opener::Wrap(tag) => Html::Wrap(tag, children),
                    Opener::Link(href) => Html::Link { href, children },
                };
                stack.last_mut().expect("the root level").1.push(node);
            }
        }
    }
    stack.pop().map(|(_, root)| root).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(url: &str) -> Html {
        Html::Media(Media::Image {
            url: url.to_owned(),
            alt: "x".to_owned(),
        })
    }

    fn text(value: &str) -> Html {
        Html::Text(value.to_owned())
    }

    #[test]
    fn an_image_between_words_leaves_one_space() {
        let (content, images) =
            lift_images(&[text("see "), image("u"), text(" now")], false).expect("lifted");
        assert_eq!(content, vec![text("see now")]);
        assert_eq!(images.len(), 1);
    }

    #[test]
    fn an_image_at_an_edge_leaves_nothing() {
        let (content, _) = lift_images(&[text("see "), image("u")], false).expect("lifted");
        assert_eq!(content, vec![text("see")]);
    }

    #[test]
    fn a_paragraph_of_images_only_is_left_alone() {
        assert!(lift_images(&[image("a"), text(" "), image("b")], false).is_none());
        let (heading, _) = lift_images(&[image("a")], true).expect("a heading lifts");
        assert!(heading.is_empty());
    }

    #[test]
    fn a_link_around_an_image_keeps_the_alt_as_its_label() {
        let linked = Html::Link {
            href: "p".to_owned(),
            children: vec![image("u")],
        };
        let (content, _) =
            lift_images(&[text("see "), linked, text(" now")], false).expect("lifted");
        assert_eq!(
            content,
            vec![
                text("see "),
                Html::Link {
                    href: "p".to_owned(),
                    children: vec![text("x")]
                },
                text(" now")
            ]
        );
    }
}
