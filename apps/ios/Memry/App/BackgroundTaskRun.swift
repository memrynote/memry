import BackgroundTasks

/// The part of a `BGTask` its runner touches, so tests can expire one.
protocol BackgroundTaskRun: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func setTaskCompleted(success: Bool)
}

extension BGTask: BackgroundTaskRun {}
