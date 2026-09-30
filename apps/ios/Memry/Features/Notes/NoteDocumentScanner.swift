import SwiftUI
import VisionKit

/// VisionKit's document camera: every scanned page, in order, or nothing on
/// cancel or failure.
struct NoteDocumentScanner: UIViewControllerRepresentable {
    let scanned: ([UIImage]) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let camera = VNDocumentCameraViewController()
        camera.delegate = context.coordinator
        return camera
    }

    func updateUIViewController(_: VNDocumentCameraViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: NoteDocumentScanner
        init(_ parent: NoteDocumentScanner) { self.parent = parent }

        func documentCameraViewController(
            _: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
        ) {
            parent.scanned((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
            parent.dismiss()
        }

        func documentCameraViewControllerDidCancel(_: VNDocumentCameraViewController) { parent.dismiss() }

        func documentCameraViewController(_: VNDocumentCameraViewController, didFailWithError _: Error) {
            Log.sync.error("a document scan failed")
            parent.dismiss()
        }
    }
}
