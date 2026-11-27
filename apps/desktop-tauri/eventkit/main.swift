// memry-eventkit: a read-only EventKit bridge for the memrynote main process (#1405).
//
// Spawned by main on macOS only, never on Windows or Linux. It speaks
// newline-delimited JSON over stdin/stdout:
//
//   request       {"id": 1, "method": "listCalendars", "params": {...}}
//   response      {"id": 1, "result": ...}
//   error         {"id": 1, "error": {"code": "not_authorized", "message": "..."}}
//   notification  {"event": "ready", "protocol": 1}
//                 {"event": "changed"}              (EKEventStoreChanged)
//
// The helper exits when stdin closes, so it never outlives the app. It only
// reads: nothing here saves, edits or deletes a calendar item.

import CoreGraphics
import EventKit
import Foundation

let protocolVersion = 1

// EventKit silently truncates a predicate longer than four years.
let maxPredicateSpan: TimeInterval = 4 * 365 * 24 * 60 * 60

struct BridgeError: Error {
  let code: String
  let message: String
}

final class Bridge {
  private var store = EKEventStore()
  private let output = FileHandle.standardOutput
  private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter
  }()
  private let isoParser: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private let isoParserNoFraction: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()
  private let untilFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter
  }()
  private var changeObserver: NSObjectProtocol?

  func start() {
    changeObserver = NotificationCenter.default.addObserver(
      forName: .EKEventStoreChanged,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.emit(["event": "changed"])
    }
    emit(["event": "ready", "protocol": protocolVersion])
  }

  // MARK: - Output

  func emit(_ message: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(message),
      var data = try? JSONSerialization.data(withJSONObject: message, options: [])
    else {
      return
    }
    data.append(0x0A)
    output.write(data)
  }

  func respond(id: Any, result: Any) {
    emit(["id": id, "result": result])
  }

  func fail(id: Any, _ error: BridgeError) {
    emit(["id": id, "error": ["code": error.code, "message": error.message]])
  }

  // MARK: - Dispatch

  func handle(line: String) {
    guard let data = line.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data, options: []),
      let request = object as? [String: Any],
      let id = request["id"],
      let method = request["method"] as? String
    else {
      emit(["event": "protocol_error", "message": "Unreadable request"])
      return
    }
    let params = request["params"] as? [String: Any] ?? [:]

    switch method {
    case "authorizationStatus":
      respond(id: id, result: authorizationStatus())
    case "requestFullAccess":
      requestFullAccess { [weak self] status in
        self?.respond(id: id, result: status)
      }
    case "listCalendars":
      do {
        respond(id: id, result: try listCalendars())
      } catch let error as BridgeError {
        fail(id: id, error)
      } catch {
        fail(id: id, BridgeError(code: "internal", message: "\(error)"))
      }
    case "listEvents":
      do {
        respond(id: id, result: try listEvents(params: params))
      } catch let error as BridgeError {
        fail(id: id, error)
      } catch {
        fail(id: id, BridgeError(code: "internal", message: "\(error)"))
      }
    default:
      fail(id: id, BridgeError(code: "unknown_method", message: method))
    }
  }

  // MARK: - Authorization

  func authorizationStatus() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
      switch status {
      case .fullAccess: return "full_access"
      case .writeOnly: return "write_only"
      default: break
      }
    }
    switch status {
    case .notDetermined: return "not_determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    // `.authorized` is what macOS 13 and older report for full access; on 14+
    // it is the same raw value as `.fullAccess`, handled above.
    case .authorized: return "full_access"
    default: return "denied"
    }
  }

  /**
   The system dialog only ever appears for `not_determined`; for any other
   state this answers with the current status straight away. A store created
   before access was granted keeps returning nothing, so it is replaced.
   */
  func requestFullAccess(completion: @escaping (String) -> Void) {
    let finish: (Bool, Error?) -> Void = { [weak self] _, _ in
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.store = EKEventStore()
        completion(self.authorizationStatus())
      }
    }
    if #available(macOS 14.0, *) {
      store.requestFullAccessToEvents(completion: finish)
    } else {
      store.requestAccess(to: .event, completion: finish)
    }
  }

  private func requireFullAccess() throws {
    let status = authorizationStatus()
    if status != "full_access" {
      throw BridgeError(code: "not_authorized", message: status)
    }
  }

  // MARK: - Reading

  func listCalendars() throws -> [[String: Any]] {
    try requireFullAccess()
    return store.calendars(for: .event).map { calendar in
      var entry: [String: Any] = [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "type": calendarType(calendar.type),
        "allowsModifications": calendar.allowsContentModifications,
      ]
      if let color = hexColor(calendar.cgColor) {
        entry["color"] = color
      }
      if let source = calendar.source {
        entry["sourceId"] = source.sourceIdentifier
        entry["sourceTitle"] = source.title
        entry["sourceType"] = sourceType(source.sourceType)
      }
      return entry
    }
  }

  func listEvents(params: [String: Any]) throws -> [[String: Any]] {
    try requireFullAccess()
    guard let startText = params["start"] as? String, let start = parseDate(startText),
      let endText = params["end"] as? String, let end = parseDate(endText), end > start
    else {
      throw BridgeError(code: "invalid_params", message: "start and end must be ISO instants")
    }
    if end.timeIntervalSince(start) > maxPredicateSpan {
      throw BridgeError(code: "span_too_long", message: "EventKit truncates spans over four years")
    }
    let wanted = Set(params["calendarIds"] as? [String] ?? [])
    // An empty list must read nothing: a nil calendar list means "every calendar".
    let calendars = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
    if calendars.isEmpty { return [] }

    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    return store.events(matching: predicate).compactMap(eventEntry)
  }

  private func eventEntry(_ event: EKEvent) -> [String: Any]? {
    guard let calendar = event.calendar, let startDate = event.startDate,
      let endDate = event.endDate
    else {
      return nil
    }
    var entry: [String: Any] = [
      "calendarId": calendar.calendarIdentifier,
      "title": event.title ?? "",
      "isAllDay": event.isAllDay,
      "status": eventStatus(event.status),
      "availability": availability(event.availability),
      "isRecurring": event.hasRecurrenceRules,
    ]
    if let identifier = event.eventIdentifier { entry["eventId"] = identifier }
    if let external = event.calendarItemExternalIdentifier, !external.isEmpty {
      entry["externalId"] = external
    }
    if let location = event.location, !location.isEmpty { entry["location"] = location }
    if let notes = event.notes, !notes.isEmpty { entry["notes"] = notes }
    if let url = event.url { entry["url"] = url.absoluteString }
    if let modified = event.lastModifiedDate { entry["lastModified"] = iso(modified) }
    if let occurrence = event.occurrenceDate { entry["occurrenceStart"] = iso(occurrence) }

    if let attendees = event.attendees, !attendees.isEmpty {
      entry["attendees"] = attendees.map(participantEntry)
    }
    if let organizer = event.organizer {
      entry["organizer"] = participantEntry(organizer)
    }
    if let alarms = event.alarms, !alarms.isEmpty {
      entry["alarmMinutes"] = alarms.map { alarm -> Int in
        // Relative offsets are seconds from the start, negative before it.
        if let absolute = alarm.absoluteDate {
          return Int((startDate.timeIntervalSince(absolute) / 60).rounded())
        }
        return Int((-alarm.relativeOffset / 60).rounded())
      }
    }
    if let rule = event.recurrenceRules?.first {
      entry["recurrenceRule"] = rruleString(rule)
    }

    if event.isAllDay {
      // All-day events are floating dates. EventKit reports local midnight to
      // (usually) 23:59:59 of the last day; hand main the calendar dates so it
      // stores them the way every other provider does.
      let calendarForDates = Calendar.current
      entry["startDate"] = dayString(startDate, calendarForDates)
      let lastInstant = max(startDate, endDate.addingTimeInterval(-1))
      entry["lastDate"] = dayString(lastInstant, calendarForDates)
    } else {
      entry["start"] = iso(startDate)
      entry["end"] = iso(endDate)
      if let zone = event.timeZone { entry["timeZone"] = zone.identifier }
    }
    return entry
  }

  // MARK: - Mapping helpers

  private func participantEntry(_ participant: EKParticipant) -> [String: Any] {
    var entry: [String: Any] = [
      "status": participantStatus(participant.participantStatus),
      "role": participantRole(participant.participantRole),
      "type": participantType(participant.participantType),
      "isCurrentUser": participant.isCurrentUser,
    ]
    if let name = participant.name, !name.isEmpty { entry["name"] = name }
    let url = participant.url
    if url.scheme?.lowercased() == "mailto" {
      // `mailto:` URLs keep the address in the resource specifier.
      let address = url.absoluteString.dropFirst("mailto:".count)
      entry["email"] = address.removingPercentEncoding ?? String(address)
    }
    return entry
  }

  private func participantStatus(_ status: EKParticipantStatus) -> String {
    switch status {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending, .unknown, .inProcess: return "pending"
    case .delegated: return "delegated"
    case .completed: return "completed"
    @unknown default: return "pending"
    }
  }

  private func participantRole(_ role: EKParticipantRole) -> String {
    switch role {
    case .required: return "required"
    case .optional: return "optional"
    case .chair: return "chair"
    case .nonParticipant: return "non_participant"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private func participantType(_ type: EKParticipantType) -> String {
    switch type {
    case .person: return "person"
    case .room: return "room"
    case .resource: return "resource"
    case .group: return "group"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private static let weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

  /// The rule as an RFC 5545 RRULE value (without the `RRULE:` prefix), the
  /// same shape Memry stores for its own events.
  private func rruleString(_ rule: EKRecurrenceRule) -> String {
    var parts: [String] = []
    switch rule.frequency {
    case .daily: parts.append("FREQ=DAILY")
    case .weekly: parts.append("FREQ=WEEKLY")
    case .monthly: parts.append("FREQ=MONTHLY")
    case .yearly: parts.append("FREQ=YEARLY")
    @unknown default: parts.append("FREQ=DAILY")
    }
    if rule.interval > 1 { parts.append("INTERVAL=\(rule.interval)") }
    if let days = rule.daysOfTheWeek, !days.isEmpty {
      let codes = days.map { day -> String in
        let code = Bridge.weekdayCodes[max(0, min(6, day.dayOfTheWeek.rawValue - 1))]
        return day.weekNumber == 0 ? code : "\(day.weekNumber)\(code)"
      }
      parts.append("BYDAY=\(codes.joined(separator: ","))")
    }
    if let days = rule.daysOfTheMonth, !days.isEmpty {
      parts.append("BYMONTHDAY=\(days.map { $0.stringValue }.joined(separator: ","))")
    }
    if let months = rule.monthsOfTheYear, !months.isEmpty {
      parts.append("BYMONTH=\(months.map { $0.stringValue }.joined(separator: ","))")
    }
    if let positions = rule.setPositions, !positions.isEmpty {
      parts.append("BYSETPOS=\(positions.map { $0.stringValue }.joined(separator: ","))")
    }
    if let end = rule.recurrenceEnd {
      if let endDate = end.endDate {
        parts.append("UNTIL=\(untilFormatter.string(from: endDate))")
      } else if end.occurrenceCount > 0 {
        parts.append("COUNT=\(end.occurrenceCount)")
      }
    }
    return parts.joined(separator: ";")
  }

  private func parseDate(_ text: String) -> Date? {
    isoParser.date(from: text) ?? isoParserNoFraction.date(from: text)
  }

  private func iso(_ date: Date) -> String {
    isoFormatter.string(from: date)
  }

  private func dayString(_ date: Date, _ calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  private func hexColor(_ color: CGColor?) -> String? {
    guard let color = color,
      let srgb = CGColorSpace(name: CGColorSpace.sRGB),
      let converted = color.converted(to: srgb, intent: .defaultIntent, options: nil),
      let components = converted.components, components.count >= 3
    else {
      return nil
    }
    let channel = { (value: CGFloat) -> Int in Int((min(max(value, 0), 1) * 255).rounded()) }
    return String(
      format: "#%02x%02x%02x", channel(components[0]), channel(components[1]),
      channel(components[2]))
  }

  private func calendarType(_ type: EKCalendarType) -> String {
    switch type {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
  }

  private func sourceType(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "mobileme"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown"
    }
  }

  private func eventStatus(_ status: EKEventStatus) -> String {
    switch status {
    case .none: return "none"
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "canceled"
    @unknown default: return "none"
    }
  }

  private func availability(_ value: EKEventAvailability) -> String {
    switch value {
    case .notSupported: return "not_supported"
    case .busy: return "busy"
    case .free: return "free"
    case .tentative: return "tentative"
    case .unavailable: return "unavailable"
    @unknown default: return "not_supported"
    }
  }
}

let bridge = Bridge()

// `--probe` is a developer harness: print the authorization status and exit,
// without prompting. Everything else goes through the stdin protocol.
if CommandLine.arguments.contains("--probe") {
  print(bridge.authorizationStatus())
  exit(0)
}

bridge.start()

// stdin is read on its own thread; every request is handled on the main queue,
// which is also where change notifications arrive, so output never interleaves.
let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    DispatchQueue.main.async { bridge.handle(line: line) }
  }
  // The app closed our stdin (it quit or crashed): nothing is left to serve.
  DispatchQueue.main.async { exit(0) }
}
reader.start()

dispatchMain()
