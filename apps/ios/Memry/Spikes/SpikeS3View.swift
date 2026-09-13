import SwiftUI
import UIKit
import WebKit

/// The screen the S3 screenshots are taken from. Reached only with the
/// `--spike-s3` launch argument; the scaffold root view is unchanged otherwise.
struct SpikeS3View: View {
    @State private var report = SpikeS3Report()

    var body: some View {
        VStack(spacing: 0) {
            Text(banner)
                .font(.caption.monospaced())
                .accessibilityIdentifier("spike-s3-banner")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.thinMaterial)
            SpikeWebViewRepresentable(report: $report)
        }
    }

    private var banner: String {
        let reduced = UIAccessibility.isReduceTransparencyEnabled ? "ON" : "OFF"
        return """
            origin=\(report.origin.isEmpty ? "…" : report.origin) \
            secureContext=\(report.isSecureContext) subtle=\(report.hasCryptoSubtle)
            localStorage throws=\(report.localStorageThrows) \
            sessionStorage throws=\(report.sessionStorageThrows) \
            indexedDB unavailable=\(report.indexedDbUnavailable) · ReduceTransparency=\(reduced)
            """
    }
}

struct SpikeWebViewRepresentable: UIViewRepresentable {
    @Binding var report: SpikeS3Report

    func makeUIView(context: Context) -> SpikeEditorWebView {
        let webView = SpikeS3.makeWebView()
        webView.accessibilityIdentifier = "spike-s3-webview"
        Task { @MainActor in
            report = await SpikeS3.run(in: webView)
        }
        return webView
    }

    func updateUIView(_ uiView: SpikeEditorWebView, context: Context) {}
}
