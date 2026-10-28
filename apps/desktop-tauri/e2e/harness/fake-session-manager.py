"""A desktop session manager on the session bus, for the Linux logout specs.

Usage: fake-session-manager.py gnome|xfce

Owns org.gnome.SessionManager or org.xfce.SessionManager and speaks the client protocol both
use: RegisterClient, then QueryEndSession, EndSession and Stop to the client, answered with
EndSessionResponse. A line "logout" on stdin starts a logout. When the client answers EndSession
or its connection closes, the session is over: the fake ends the client with SIGKILL, as the
display server going away ends it with Xlib's IO error. Each step is a JSON line on stdout.
"""

import json
import os
import signal
import sys
import time

from gi.repository import Gio, GLib

PROTOCOLS = {
    "gnome": (
        "org.gnome.SessionManager",
        "/org/gnome/SessionManager",
        "org.gnome.SessionManager",
        "/org/gnome/SessionManager/Client1",
        "org.gnome.SessionManager.ClientPrivate",
    ),
    "xfce": (
        "org.xfce.SessionManager",
        "/org/xfce/SessionManager",
        "org.xfce.Session.Manager",
        "/org/xfce/SessionClients/client1",
        "org.xfce.Session.Client",
    ),
}

SERVICE, MANAGER_PATH, MANAGER_IFACE, CLIENT_PATH, CLIENT_IFACE = PROTOCOLS[sys.argv[1]]

NODE = Gio.DBusNodeInfo.new_for_xml(
    f"""
<node>
  <interface name="{MANAGER_IFACE}">
    <method name="RegisterClient">
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="o" direction="out"/>
    </method>
  </interface>
  <interface name="{CLIENT_IFACE}">
    <method name="EndSessionResponse">
      <arg type="b" direction="in"/><arg type="s" direction="in"/>
    </method>
    <signal name="QueryEndSession"><arg type="u"/></signal>
    <signal name="EndSession"><arg type="u"/></signal>
    <signal name="CancelEndSession"/>
    <signal name="Stop"/>
  </interface>
</node>"""
)

state = {"phase": "idle", "client": None, "pid": None}
bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def report(event, **fields):
    print(json.dumps({"event": event, "ms": round(time.monotonic() * 1000), **fields}), flush=True)


def emit(name):
    bus.emit_signal(
        state["client"], CLIENT_PATH, CLIENT_IFACE, name,
        None if name == "Stop" else GLib.Variant("(u)", (1,)),
    )
    report("sent", signal=name)


def end_session(reason):
    """The session is over: the display server would be gone now."""
    if state["phase"] == "over":
        return
    state["phase"] = "over"
    report("over", reason=reason)
    if state["pid"]:
        try:
            os.kill(state["pid"], signal.SIGKILL)
            report("killed", pid=state["pid"])
        except ProcessLookupError:
            report("already-gone", pid=state["pid"])


def on_method(connection, sender, path, iface, method, params, invocation):
    if method == "RegisterClient":
        app_id, startup_id = params.unpack()
        state["client"] = sender
        state["pid"] = bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", GLib.Variant("(s)", (sender,)),
            GLib.VariantType("(u)"), 0, -1,
        ).unpack()[0]
        report("registered", appId=app_id, startupId=startup_id, pid=state["pid"])
        invocation.return_value(GLib.Variant("(o)", (CLIENT_PATH,)))
    elif method == "EndSessionResponse":
        ok, reason = params.unpack()
        invocation.return_value(None)
        report("answered", phase=state["phase"], ok=ok, reason=reason)
        if state["phase"] == "query":
            state["phase"] = "end"
            emit("EndSession")
        elif state["phase"] == "end":
            end_session("answered")


def on_name_owner_changed(connection, sender, path, iface, signal_name, params, data):
    name, _old, new = params.unpack()
    if name == state["client"] and not new:
        report("disconnected")
        if state["phase"] in ("query", "end"):
            end_session("disconnected")


def on_stdin(source, condition):
    line = sys.stdin.readline()
    if not line:
        loop.quit()
        return False
    if line.strip() == "logout" and state["client"]:
        state["phase"] = "query"
        emit("QueryEndSession")
    return True


for info in NODE.interfaces:
    bus.register_object(MANAGER_PATH if info.name == MANAGER_IFACE else CLIENT_PATH, info, on_method)
bus.signal_subscribe(
    "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus",
    None, Gio.DBusSignalFlags.NONE, on_name_owner_changed, None,
)
loop = GLib.MainLoop()
Gio.bus_own_name_on_connection(
    bus, SERVICE, Gio.BusNameOwnerFlags.NONE, lambda *_: report("ready"), lambda *_: report("lost-name")
)
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
loop.run()
