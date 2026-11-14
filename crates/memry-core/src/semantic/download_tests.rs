use std::fs;
use std::sync::Arc;

use super::*;
use crate::api::errors::TransportError;
use crate::semantic::fakes::{Cdn, Scratch, Wifi, files, manifest, response};

const MIB8: u64 = RANGE_BYTES;

struct Setup {
    _scratch: Scratch,
    dir: ModelDir,
    cdn: Arc<Cdn>,
    wifi: Arc<Wifi>,
}

fn setup() -> Setup {
    let scratch = Scratch::new();
    let files = files();
    let dir = scratch.models(manifest(&files));
    dir.set_opted_in().unwrap();
    Setup {
        cdn: Cdn::new(&files),
        wifi: Wifi::on(),
        dir,
        _scratch: scratch,
    }
}

impl Setup {
    async fn run(&self) -> Result<DownloadEnd, DownloadError> {
        download(&self.dir, &*self.cdn, &*self.wifi).await
    }

    fn data(&self) -> &'static ModelFile {
        &self.dir.manifest().files[0]
    }
}

fn failure(result: Result<DownloadEnd, DownloadError>) -> DownloadFailure {
    match result {
        Err(DownloadError::Failed(failure)) => failure,
        other => panic!("expected a download failure, got {other:?}"),
    }
}

#[tokio::test]
async fn downloads_every_file_in_ranges_through_the_redirect_and_verifies_it() {
    let s = setup();
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);

    let verified = s.dir.verified().expect("verified");
    for (path, bytes) in files() {
        assert_eq!(fs::read(verified.dir().join(path)).unwrap(), bytes);
    }
    let size = s.data().size;
    assert_eq!(
        s.cdn.ranges(),
        vec![
            (
                "https://cdn.test/onnx/model.onnx_data".into(),
                format!("bytes=0-{}", MIB8 - 1)
            ),
            (
                "https://cdn.test/onnx/model.onnx_data".into(),
                format!("bytes={MIB8}-{}", size - 1)
            ),
            (
                "https://cdn.test/tokenizer.json".into(),
                "bytes=0-10".into()
            ),
        ]
    );
    for request in s.cdn.requests.lock().unwrap().iter() {
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.headers.keys().collect::<Vec<_>>(),
            ["range"],
            "no memry headers to a third party"
        );
        assert_eq!(request.body, None);
    }

    let calls = s.cdn.requests.lock().unwrap().len();
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);
    assert_eq!(
        s.cdn.requests.lock().unwrap().len(),
        calls,
        "a finished model fetches nothing"
    );
}

#[tokio::test]
async fn a_failed_range_keeps_the_part_and_the_next_run_resumes_from_its_length() {
    let s = setup();
    s.cdn.hook(|call, _| {
        (call == 3).then(|| {
            Err(TransportError::Failed {
                what: "reset".into(),
            })
        })
    });
    assert_eq!(failure(s.run().await), DownloadFailure::Network);
    assert_eq!(model::len(&s.dir.part_path(s.data())), MIB8);
    assert!(s.dir.verified().is_none());

    s.cdn.hook(|_, _| None);
    s.cdn.requests.lock().unwrap().clear();
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);
    assert_eq!(
        s.cdn.ranges()[0].1,
        format!("bytes={MIB8}-{}", s.data().size - 1)
    );
    assert!(s.dir.verified().is_some());
}

#[tokio::test]
async fn leaving_wifi_mid_file_stops_before_the_next_range_and_wifi_resumes_it() {
    let s = setup();
    let wifi = s.wifi.clone();
    s.cdn.hook(move |call, _| {
        if call == 1 {
            wifi.set(Reachable::Cellular);
        }
        None
    });
    assert_eq!(s.run().await.unwrap(), DownloadEnd::NotOnWifi);
    assert_eq!(s.cdn.ranges().len(), 1);
    assert!(!s.dir.final_path(s.data()).exists());

    s.wifi.set(Reachable::Wifi);
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);
}

#[tokio::test]
async fn a_network_error_after_wifi_drops_waits_for_wifi_instead_of_failing() {
    let s = setup();
    let wifi = s.wifi.clone();
    s.cdn.hook(move |_, _| {
        wifi.set(Reachable::Offline);
        Some(Err(TransportError::Offline))
    });
    assert_eq!(s.run().await.unwrap(), DownloadEnd::NotOnWifi);
}

#[tokio::test]
async fn opting_out_mid_file_stops_before_the_next_range() {
    let s = setup();
    let marker = s.dir.clone();
    s.cdn.hook(move |call, _| {
        if call == 1 {
            marker.clear().unwrap();
        }
        None
    });
    assert_eq!(s.run().await.unwrap(), DownloadEnd::OptedOut);
    assert_eq!(s.cdn.ranges().len(), 1);
}

#[tokio::test]
async fn a_hash_mismatch_deletes_the_part_and_never_names_the_file() {
    let s = setup();
    s.cdn.hook(|_, request| {
        let range = &request.headers["range"];
        (request.url == "https://cdn.test/tokenizer.json").then(|| {
            assert_eq!(range, "bytes=0-10");
            Ok(response(
                206,
                &[("content-range", "bytes 0-10/11")],
                b"{\"vocab\":2}".to_vec(),
            ))
        })
    });
    assert_eq!(failure(s.run().await), DownloadFailure::Mismatch);
    let tokenizer = &s.dir.manifest().files[1];
    assert!(!s.dir.part_path(tokenizer).exists());
    assert!(!s.dir.final_path(tokenizer).exists());
    assert!(
        s.dir.is_final(s.data()),
        "the file that matched keeps its final name"
    );

    s.cdn.hook(|_, _| None);
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);
}

#[tokio::test]
async fn a_full_200_answer_to_a_range_is_refused() {
    let s = setup();
    s.cdn
        .hook(|call, _| (call == 1).then(|| Ok(response(200, &[], vec![0; 11]))));
    assert_eq!(
        failure(s.run().await),
        DownloadFailure::Http { status: 200 }
    );
    assert_eq!(model::len(&s.dir.part_path(s.data())), 0);
}

#[tokio::test]
async fn a_range_other_than_the_one_asked_for_is_refused() {
    for content_range in ["bytes 5-15/8389608", "bytes 0-15/8389608", "nonsense"] {
        let s = setup();
        s.cdn.hook(move |call, _| {
            (call == 1).then(|| {
                Ok(response(
                    206,
                    &[("content-range", content_range)],
                    vec![0; 11],
                ))
            })
        });
        assert_eq!(
            failure(s.run().await),
            DownloadFailure::Http { status: 206 },
            "{content_range}"
        );
        assert_eq!(model::len(&s.dir.part_path(s.data())), 0);
    }
}

#[tokio::test]
async fn a_different_total_size_is_a_different_file() {
    let s = setup();
    s.cdn.hook(|call, _| {
        (call == 1).then(|| {
            Ok(response(
                206,
                &[("content-range", "bytes 0-10/99")],
                vec![0; 11],
            ))
        })
    });
    assert_eq!(failure(s.run().await), DownloadFailure::Mismatch);
}

#[tokio::test]
async fn redirects_follow_https_and_root_relative_locations_only() {
    let s = setup();
    s.cdn.hook(|_, request| {
        let path = request.url.strip_prefix("https://models.test/repo/")?;
        Some(Ok(response(
            302,
            &[("location", &format!("/repo/{path}"))],
            vec![],
        )))
    });
    assert_eq!(
        failure(s.run().await),
        DownloadFailure::Http { status: 302 }
    );
    let requests = s.cdn.requests.lock().unwrap().clone();
    assert_eq!(
        requests[1].url,
        "https://models.test/repo/onnx/model.onnx_data"
    );
    assert_eq!(
        requests[1].headers["range"], requests[0].headers["range"],
        "the range survives a hop"
    );
    assert_eq!(requests.len(), 1 + MAX_REDIRECTS, "at most three hops");

    let s = setup();
    s.cdn.hook(|call, _| {
        (call == 0).then(|| {
            Ok(response(
                302,
                &[("location", "http://cdn.test/onnx/model.onnx_data")],
                vec![],
            ))
        })
    });
    assert_eq!(
        failure(s.run().await),
        DownloadFailure::Http { status: 302 }
    );
    assert_eq!(
        s.cdn.requests.lock().unwrap().len(),
        1,
        "never downgrades to http"
    );
}

#[tokio::test]
async fn a_part_longer_than_its_file_starts_over() {
    let s = setup();
    let part = s.dir.part_path(s.data());
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::write(&part, vec![7; s.data().size as usize + 1]).unwrap();
    assert_eq!(s.run().await.unwrap(), DownloadEnd::Complete);
    assert_eq!(s.cdn.ranges()[0].1, format!("bytes=0-{}", MIB8 - 1));
}
