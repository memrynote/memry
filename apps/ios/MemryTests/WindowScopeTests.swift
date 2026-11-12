//
//  WindowScopeTests.swift
//  #4344: an iPad window shares the screen, the keyboard and the camera with
//  other apps' windows. The editor reads only its own screen's keyboard, a
//  Reduce Motion panel swap leaves the rest of the app animating, and a
//  camera paused mid-scan says why.
//

import AVFoundation
import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

private final class NoEditor: BlockEditing, @unchecked Sendable {
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool { true }
}

@MainActor
private func focusedField(in window: UIWindow) -> (EditorSession, BlockField) {
    let session = NoteEditorViewModel(noteId: "note-1", editor: NoEditor()).session
    let block = Block(
        id: "a", kind: "paragraph", depth: 0, props: [],
        inline: [InlineRun(text: "hello", marks: [], markAttrs: [:], target: nil)]
    )
    let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
    let field = BlockField(block: block, session: session, style: style, alignment: .natural)
    window.addSubview(field.textView)
    session.focusChanged(to: field)
    return (session, field)
}

@MainActor
@Suite("window scope", .serialized)
struct WindowScopeTests {
    private func window() throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.isHidden = false
        return window
    }

    private func keyboardWillShow(height: CGFloat, on screen: UIScreen?) {
        NotificationCenter.default.post(
            name: UIResponder.keyboardWillShowNotification,
            object: screen,
            userInfo: [UIResponder.keyboardFrameEndUserInfoKey: CGRect(x: 0, y: 400, width: 800, height: height)]
        )
    }

    @Test func the_editor_sizes_its_panel_only_from_its_own_screens_keyboard() throws {
        let window = try window()
        defer { window.isHidden = true }
        let (session, field) = focusedField(in: window)
        defer { withExtendedLifetime(field) {} }
        let before = session.keyboardHeight

        keyboardWillShow(height: 520, on: nil)
        #expect(session.keyboardHeight == before, "a keyboard on no named screen is not this window's")

        keyboardWillShow(height: 520, on: window.windowScene?.screen)
        #expect(session.keyboardHeight == 520 - session.accessory.frame.height)
    }

    @Test func a_reduce_motion_panel_swap_leaves_the_app_animating() throws {
        let window = try window()
        defer { window.isHidden = true }
        let (session, field) = focusedField(in: window)
        defer { withExtendedLifetime(field) {} }
        session.reduceMotion = { true }

        session.show(.insert)

        #expect(session.panel == .insert)
        #expect(UIView.areAnimationsEnabled, "animations elsewhere in the app keep running")
        session.show(.insert)
        #expect(UIView.areAnimationsEnabled)
    }
}

// MARK: - The camera

private final class HeldCapture: CodeCapture, @unchecked Sendable {
    private let (payloads, release) = AsyncStream<String>.makeStream()

    func permission() async -> CapturePermission { .granted }
    func requestPermission() async -> CapturePermission { .granted }

    func scan() async throws -> String {
        for await payload in payloads { return payload }
        throw CaptureError.Cancelled
    }

    func cancel() { release.finish() }
}

private final class UnusedLink: DeviceLinkProtocol, @unchecked Sendable {
    func scan(qrPayload: String) async throws -> LinkingScan { throw LinkingError.SessionExpired }
    func pollOnce() async throws -> LinkingPoll { .awaitingApproval }
    func cancel() {}
    func isPending() -> Bool { false }
}

private final class EmptyStore: SecureStore, @unchecked Sendable {
    func get(key: SecureStoreKey) throws -> Data? { nil }
    func set(key: SecureStoreKey, value: Data) throws {}
    func delete(key: SecureStoreKey) throws {}
    func clear() throws {}
}

@MainActor
@Suite("camera interruption")
struct CameraInterruptionTests {
    @Test func a_camera_paused_mid_scan_says_why_until_it_is_back() async {
        let center = NotificationCenter()
        let capture = HeldCapture()
        let model = DeviceLinkingViewModel(
            link: UnusedLink(), capture: capture, secureStore: EmptyStore(),
            executor: CoreExecutor(label: "4344-tests"), notifications: center
        )
        let scanning = Task { await model.scanWithCamera() }
        while model.phase != .scanning { await Task.yield() }

        center.post(
            name: AVCaptureSession.wasInterruptedNotification, object: nil,
            userInfo: [
                AVCaptureSessionInterruptionReasonKey:
                    AVCaptureSession.InterruptionReason.videoDeviceNotAvailableWithMultipleForegroundApps.rawValue,
            ]
        )
        #expect(model.cameraInterruption == .sharedScreen)
        #expect(model.phase == .scanning, "the scan waits for the camera instead of failing")

        center.post(name: AVCaptureSession.interruptionEndedNotification, object: nil)
        #expect(model.cameraInterruption == nil)

        center.post(
            name: AVCaptureSession.wasInterruptedNotification, object: nil,
            userInfo: [AVCaptureSessionInterruptionReasonKey: AVCaptureSession.InterruptionReason.videoDeviceInUseByAnotherClient.rawValue]
        )
        #expect(model.cameraInterruption == .inUse)

        model.stopScanning()
        await scanning.value
        #expect(model.phase == .idle)
        #expect(model.cameraInterruption == nil, "a stopped scan leaves no pause notice behind")
    }
}
