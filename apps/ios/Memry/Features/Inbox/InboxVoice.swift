import AVFoundation
import Speech
import SwiftUI

// IB06 (D4). Voice memos: recorded with `AVAudioRecorder` as AAC in `.m4a`,
// transcribed with `SFSpeechRecognizer` **on this device only**
// (`requiresOnDeviceRecognition`): audio never leaves the phone for
// transcription. Where on-device recognition is unavailable for the locale
// the memo keeps `transcriptionStatus = failed` with Retry.

enum InboxTranscriber {
    static var isAvailable: Bool {
        guard let recognizer = SFSpeechRecognizer() else { return false }
        return recognizer.supportsOnDeviceRecognition
    }

    /// The transcript, or `nil` when it could not be made on this device.
    static func transcribe(_ url: URL) async -> String? {
        guard await authorize(), let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else {
            return nil
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        return await withCheckedContinuation { continuation in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let result, result.isFinal {
                    finished = true
                    let text = result.bestTranscription.formattedString
                    continuation.resume(returning: text.isEmpty ? nil : text)
                } else if error != nil {
                    finished = true
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func authorize() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }
}

/// The recorder behind Paper 06: timer, live level for the waveform, cancel,
/// stop = capture. Desktop's 300 s cap (`CaptureVoiceStorageSchema`).
@MainActor
@Observable
final class InboxVoiceRecorder {
    enum Phase: Equatable { case idle, requesting, recording, denied, failed }

    static let maxSeconds: TimeInterval = 300

    private(set) var phase: Phase = .idle
    private(set) var elapsed: TimeInterval = 0
    /// Recent levels, 0...1, newest last (the waveform).
    private(set) var levels: [Double] = []
    private var recorder: AVAudioRecorder?
    private var timer: Task<Void, Never>?
    private var envelope: [Double] = []

    func start() async {
        phase = .requesting
        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else {
            phase = .denied
            return
        }
        let session = AVAudioSession.sharedInstance()
        guard session.isInputAvailable else {
            phase = .failed
            return
        }
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("memo-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else {
                phase = .failed
                return
            }
            self.recorder = recorder
            phase = .recording
            elapsed = 0
            levels = []
            envelope = []
            tick()
        } catch {
            phase = .failed
        }
    }

    private func tick() {
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, let recorder = self.recorder else { return }
                recorder.updateMeters()
                let power = Double(recorder.averagePower(forChannel: 0))
                let level = max(0, min(1, (power + 50) / 50))
                self.elapsed = recorder.currentTime
                self.levels = Array((self.levels + [level]).suffix(40))
                self.envelope.append(level)
                if self.elapsed >= Self.maxSeconds { return }
            }
        }
    }

    /// Stops and hands back the file, its duration and a 120-bucket envelope.
    func stop() -> (url: URL, duration: TimeInterval, waveform: [Double])? {
        timer?.cancel()
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return (recorder.url, duration, Self.buckets(envelope, count: 120))
    }

    func cancel() {
        timer?.cancel()
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Averages `values` into at most `count` buckets (desktop's `waveform`).
    nonisolated static func buckets(_ values: [Double], count: Int) -> [Double] {
        guard values.count > count, count > 0 else { return values }
        let size = Double(values.count) / Double(count)
        return (0 ..< count).map { index in
            let slice = values[Int(Double(index) * size) ..< min(values.count, Int(Double(index + 1) * size))]
            return slice.isEmpty ? 0 : slice.reduce(0, +) / Double(slice.count)
        }
    }
}

/// Paper 06: "Recording", the timer, the live waveform, cancel and stop.
struct InboxRecorderPanel: View {
    let recorder: InboxVoiceRecorder
    let cancel: () -> Void
    let stop: () -> Void

    /// Bars in the waveform; the ones not yet recorded wait in grey.
    private static let bars = 40
    @ScaledMetric(relativeTo: .body) private var waveHeight: CGFloat = 56
    @ScaledMetric(relativeTo: .body) private var cancelSize: CGFloat = 48
    @ScaledMetric(relativeTo: .body) private var stopSize: CGFloat = 64

    var body: some View {
        VStack(spacing: Tokens.Space.inset) {
            HStack(spacing: Tokens.Space.small) {
                Circle().fill(Tokens.Interaction.destructive.color)
                    .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                    .accessibilityHidden(true)
                Text(InboxCopy.recording)
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                Text(InboxMeta.duration(recorder.elapsed))
                    .font(Tokens.Typography.supporting.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(InboxCopy.recordingElapsed(InboxMeta.duration(recorder.elapsed)))
            }
            waveform
            Text(InboxCopy.transcribedHere)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            HStack {
                Button(action: cancel) {
                    Image(systemName: "xmark")
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.primary.color)
                        .frame(width: cancelSize, height: cancelSize)
                        .background(Tokens.Canvas.surfaceActive.color, in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(InboxCopy.cancelRecording)
                .accessibilityIdentifier("inbox.voice.cancel")
                Spacer()
                Button(action: stop) {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small - 1)
                        .fill(Tokens.Tint.foreground.color)
                        .frame(width: stopSize * 5 / 16, height: stopSize * 5 / 16)
                        .frame(width: stopSize, height: stopSize)
                        .background(Tokens.Tint.base.color, in: .circle)
                        .shadow(color: Tokens.Tint.base.color.opacity(0.32), radius: 12, y: 10)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(InboxCopy.stopRecording)
                .accessibilityIdentifier("inbox.voice.stop")
                Spacer()
                // Balances the cancel button so stop sits in the middle.
                Color.clear.frame(width: cancelSize, height: cancelSize)
            }
        }
    }

    private var waveform: some View {
        let recorded = Array(recorder.levels.suffix(Self.bars))
        return HStack(alignment: .center, spacing: 3) {
            ForEach(0 ..< Self.bars, id: \.self) { index in
                let level = index < recorded.count ? recorded[index] : nil
                RoundedRectangle(cornerRadius: 2)
                    .fill(level == nil ? Tokens.Line.border.color : Tokens.Text.primary.color)
                    .frame(width: 3, height: max(Tokens.Space.small, (level ?? 0) * waveHeight))
            }
        }
        .frame(maxWidth: .infinity, minHeight: waveHeight, maxHeight: waveHeight)
        .accessibilityHidden(true)
    }
}
