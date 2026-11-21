use memry_test_kit::{
    DEFAULT_CASES, assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound,
    proptest_config,
};
use proptest::prelude::*;

use super::*;

const LISTING: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
    xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/cal/u/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>Home</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/u/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname> Work &amp; play </d:displayname>
        <ca:calendar-color symbolic-color="red">#FF2968FF</ca:calendar-color>
        <c:calendar-timezone><![CDATA[BEGIN:VCALENDAR
TZID:Europe/Istanbul
END:VCALENDAR]]></c:calendar-timezone>
        <cs:getctag>42</cs:getctag>
        <d:sync-token>http://x/sync/7</d:sync-token>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="vtodo"/></c:supported-calendar-component-set>
        <d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:displayname>Ignored</d:displayname><cs:getctag/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

#[test]
fn reads_a_calendar_listing_like_tsdav() {
    let responses = parse_multistatus(LISTING).unwrap().unwrap();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].href.as_deref(), Some("/cal/u/"));
    assert_eq!(
        responses[0].props.resource_types,
        Some(vec!["collection".to_owned()])
    );
    let work = &responses[1];
    assert_eq!(work.status, None);
    let props = &work.props;
    assert_eq!(props.display_name.as_deref(), Some("Work & play"));
    assert_eq!(
        props.resource_types,
        Some(vec!["collection".to_owned(), "calendar".to_owned()])
    );
    assert_eq!(props.calendar_color.as_deref(), Some("#FF2968FF"));
    assert!(
        props
            .calendar_timezone
            .as_deref()
            .unwrap()
            .contains("TZID:Europe/Istanbul")
    );
    assert_eq!(
        props.getctag.as_deref(),
        Some("42"),
        "the 404 propstat is not merged"
    );
    assert_eq!(props.sync_token.as_deref(), Some("http://x/sync/7"));
    assert_eq!(
        props.components,
        Some(vec!["VEVENT".to_owned(), "VTODO".to_owned()])
    );
    assert_eq!(props.reports, Some(vec!["sync-collection".to_owned()]));
}

#[test]
fn reads_principal_and_home_hrefs_and_the_response_status() {
    let body = r#"<multistatus xmlns="DAV:"><response><href>/</href>
        <status>HTTP/1.1 403 Forbidden</status>
        <propstat><prop><current-user-principal><href> /p/u/ </href></current-user-principal>
        <C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><href></href><href>/home/u/</href><href>/other/</href></C:calendar-home-set>
        </prop></propstat></response></multistatus>"#;
    let response = &parse_multistatus(body).unwrap().unwrap()[0];
    assert_eq!(response.status, Some(403));
    assert_eq!(
        response.props.current_user_principal.as_deref(),
        Some("/p/u/")
    );
    assert_eq!(
        response.props.calendar_home_set.as_deref(),
        Some("/home/u/"),
        "the first non-empty href, as extractHref"
    );
}

#[test]
fn another_root_is_not_a_multistatus_and_broken_xml_is_refused() {
    assert_eq!(parse_multistatus("<html><body/></html>"), Ok(None));
    assert_eq!(parse_multistatus("not xml at all"), Ok(None));
    assert_eq!(
        parse_multistatus("<multistatus><response>"),
        Err(XmlError::Malformed)
    );
    assert_eq!(
        parse_multistatus("<multistatus><a></b></multistatus>"),
        Err(XmlError::Malformed)
    );
    assert_eq!(
        parse_multistatus("<multistatus>&custom;</multistatus>"),
        Err(XmlError::Malformed),
        "no DTD entity is expanded"
    );
}

fn nested(depth: usize) -> String {
    format!(
        "<multistatus>{}{}</multistatus>",
        "<a>".repeat(depth),
        "</a>".repeat(depth)
    )
}

#[test]
fn nesting_past_the_bound_fails_closed_on_a_small_stack() {
    let refused = on_small_stack(|| parse_multistatus(&nested(200_000)));
    assert_eq!(refused, Err(XmlError::TooDeep));
    let kept = on_small_stack(|| parse_multistatus(&nested(MAX_DEPTH - 2)));
    assert_eq!(kept, Ok(Some(Vec::new())));
}

#[test]
fn the_reader_takes_at_most_one_step_per_input_byte() {
    let mut body = String::from("<multistatus>");
    for i in 0..2_000 {
        body.push_str(&format!(
            "<response><href>/c/{i}/</href><propstat><prop><displayname>n{i}</displayname>\
             <resourcetype><collection/><calendar/></resourcetype></prop></propstat></response>"
        ));
    }
    body.push_str("</multistatus>");
    let len = body.len();
    assert_steps_at_most("multistatus events", steps, len + 2, || {
        assert_eq!(parse_multistatus(&body).unwrap().unwrap().len(), 2_000);
    });
}

fn output_len(responses: &[DavResponse]) -> usize {
    responses
        .iter()
        .map(|r| r.href.as_ref().map_or(0, String::len) + r.props.text_len())
        .sum()
}

#[test]
fn the_output_is_bounded_by_the_input() {
    let responses = parse_multistatus(LISTING).unwrap().unwrap();
    assert_output_bounded("multistatus", LISTING.len(), output_len(&responses));
}

proptest! {
    #![proptest_config(proptest_config(DEFAULT_CASES))]

    #[test]
    fn any_mutation_of_a_listing_reads_or_fails_closed(
        cut in 0usize..LISTING.len(),
        insert in "[<>/&a-z\"=; ]{0,12}",
    ) {
        let mut body = LISTING.to_owned();
        let at = (0..=cut).rev().find(|i| body.is_char_boundary(*i)).unwrap_or(0);
        body.insert_str(at, &insert);
        if let Ok(Some(responses)) = parse_multistatus(&body) {
            prop_assert!(output_len(&responses) <= output_bound(body.len()));
        }
    }

    #[test]
    fn arbitrary_text_never_panics(body in "\\PC{0,400}") {
        if let Ok(Some(responses)) = parse_multistatus(&body) {
            prop_assert!(output_len(&responses) <= output_bound(body.len()));
        }
    }
}
