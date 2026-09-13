import Foundation
import WebKit

/// What S3 observed in the guest document.
struct SpikeS3Report: Sendable {
    var origin = ""
    var isSecureContext = false
    var hasCryptoSubtle = false
    var localStorageThrows = false
    var sessionStorageThrows = false
    var indexedDbUnavailable = false
    var failure: String?

    /// The line `research.md` §F asks for.
    var passes: Bool { isSecureContext && hasCryptoSubtle }
}

/// The guest document. Small on purpose — S3 asks about the *origin*, not about
/// the editor bundle.
enum SpikeS3 {
    static let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, \
        interactive-widget=overlays-content">
        <style>
          body { font: 17px -apple-system; margin: 0; padding: 16px; }
          #editor { min-height: 160px; border: 1px solid #ccc; border-radius: 8px; padding: 12px; }
        </style></head><body>
        <h3>S3 — opaque origin</h3>
        <div id="editor" contenteditable="true">Tap here to raise the keyboard.</div>
        <script>
          document.getElementById('editor').addEventListener('touchend', function () {
            this.focus();
          });
        </script>
        </body></html>
        """

    /// R10's probe, verbatim: `window.isSecureContext && !!crypto.subtle`, plus
    /// the three storage APIs the constitution requires to be unavailable.
    static let probe = """
        (() => {
          const probe = { origin: String(window.origin), secure: !!window.isSecureContext,
                          subtle: !!(window.crypto && window.crypto.subtle) };
          const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
          probe.localStorage = throws(() => window.localStorage.setItem('k', 'v'));
          probe.sessionStorage = throws(() => window.sessionStorage.setItem('k', 'v'));
          probe.indexedDB = throws(() => {
            if (!window.indexedDB) { throw new Error('absent'); }
            window.indexedDB.open('k');
          });
          return JSON.stringify(probe);
        })()
        """

    @MainActor
    static func makeWebView() -> SpikeEditorWebView {
        let configuration = WKWebViewConfiguration()
        // R10: the opaque origin is what makes "persists nothing" true at the
        // platform layer, and the non-persistent store is the belt to its braces.
        configuration.websiteDataStore = .nonPersistent()
        let webView = SpikeEditorWebView(
            frame: CGRect(x: 0, y: 0, width: 393, height: 600),
            configuration: configuration
        )
        webView.isInspectable = true
        return webView
    }

    @MainActor
    static func run(in webView: SpikeEditorWebView) async -> SpikeS3Report {
        webView.loadHTMLString(html, baseURL: URL(string: "about:blank"))
        return await probe(webView)
    }

    @MainActor
    static func probe(_ webView: SpikeEditorWebView) async -> SpikeS3Report {
        var report = SpikeS3Report()
        do {
            try await waitForLoad(webView)
            let raw = try await webView.evaluateJavaScript(probe)
            guard let json = raw as? String,
                  let data = json.data(using: .utf8),
                  let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                report.failure = "probe returned \(String(describing: raw))"
                return report
            }
            report.origin = parsed["origin"] as? String ?? ""
            report.isSecureContext = parsed["secure"] as? Bool ?? false
            report.hasCryptoSubtle = parsed["subtle"] as? Bool ?? false
            report.localStorageThrows = parsed["localStorage"] as? Bool ?? false
            report.sessionStorageThrows = parsed["sessionStorage"] as? Bool ?? false
            report.indexedDbUnavailable = parsed["indexedDB"] as? Bool ?? false
        } catch {
            report.failure = String(reflecting: error)
        }
        return report
    }

    @MainActor
    private static func waitForLoad(_ webView: WKWebView) async throws {
        for _ in 0..<200 where webView.isLoading {
            try await Task.sleep(for: .milliseconds(50))
        }
        // `about:blank` with injected HTML settles fast, but the document is not
        // guaranteed interactive the instant `isLoading` clears.
        try await Task.sleep(for: .milliseconds(100))
    }
}
