import Foundation
import WebKit

/// R10's named fallback, reached because the opaque origin measured **false**
/// for `window.isSecureContext`.
///
/// R10 makes the fallback admissible only when it is paired with
/// `websiteDataStore = .nonPersistent()` **and** a startup assertion that
/// `localStorage`, `sessionStorage` and `indexedDB` each throw or are
/// unavailable — a custom scheme hands the document a real origin, and a real
/// origin re-enables web storage, which the constitution rejects.
final class SpikeSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "memry"
    static let entryUrl = "\(scheme)://editor/index.html"

    private let html: String

    init(html: String) {
        self.html = html
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let body = Data(html.utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": String(body.count),
                // The bundle is inlined, so the document needs nothing else.
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
            ]
        )
        // `HTTPURLResponse.init` is non-failable in signature but optional in
        // practice; a nil here means the URL was not one WebKit can answer for.
        guard let response else {
            urlSchemeTask.didFailWithError(URLError(.badServerResponse))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

extension SpikeS3 {
    /// Builds the fallback WebView. The handler is retained by the
    /// configuration, so it has to outlive this call.
    @MainActor
    static func runFallback(in webView: SpikeEditorWebView) async -> SpikeS3Report {
        guard let url = URL(string: SpikeSchemeHandler.entryUrl) else {
            var report = SpikeS3Report()
            report.failure = "unparseable fallback url"
            return report
        }
        webView.load(URLRequest(url: url))
        return await probe(webView)
    }
}

/// R10 makes the `WKURLSchemeHandler` fallback admissible only if
/// `localStorage`, `sessionStorage` and `indexedDB` each throw or are
/// unavailable. A real origin hands all three back, so the only way to make
/// that assertion hold is to take them away in the guest before any other
/// script runs. Measured, not assumed: S3 runs the fallback both ways.
enum SpikeStorageDenial {
    static let source = """
        (() => {
          const deny = (name) => {
            try {
              Object.defineProperty(window, name, {
                configurable: false,
                get() { throw new Error('memry: web storage is disabled'); }
              });
            } catch (error) { /* already non-configurable: report it by leaving it */ }
          };
          ['localStorage', 'sessionStorage', 'indexedDB'].forEach(deny);
        })();
        """

    /// `.atDocumentStart` in `.page`, which is where R10 puts the bridge shim.
    static var userScript: WKUserScript {
        WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }
}

extension SpikeS3 {
    @MainActor
    static func makeFallbackWebView(handler: SpikeSchemeHandler, denyingStorage: Bool) -> SpikeEditorWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(handler, forURLScheme: SpikeSchemeHandler.scheme)
        if denyingStorage {
            configuration.userContentController.addUserScript(SpikeStorageDenial.userScript)
        }
        let webView = SpikeEditorWebView(
            frame: CGRect(x: 0, y: 0, width: 393, height: 600),
            configuration: configuration
        )
        webView.isInspectable = true
        return webView
    }
}
