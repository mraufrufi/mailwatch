#!/usr/bin/env python3
"""Mail Watch IMAP helper.

Talks JSON lines with the GNOME Shell extension:

  stdin  <- {"cmd":"config","accounts":[{id,host,port,security,username,password}]}
            {"cmd":"refresh"}
            {"cmd":"mark_read","account":ID,"uids":[..]}
            {"cmd":"mark_all_read","account":ID|null}
  stdout -> {"type":"status","account":ID,"state":"connected"|"error","error":".."}
            {"type":"list","account":ID,"total":N,"messages":[..]}
            {"type":"new","account":ID,"messages":[..]}

One thread per account. Uses IMAP IDLE for realtime push, falls back to
polling when the server has no IDLE support.

`--test` reads one account as JSON on stdin and prints {"ok":bool,...}.
"""
import imaplib
import json
import os
import queue
import re
import select
import ssl
import sys
import threading
import time
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

MAX_MESSAGES = 50          # newest unread messages kept per account
IDLE_RENEW_SECONDS = 9 * 60
POLL_SECONDS = 60
CONNECT_TIMEOUT = 30

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def err_text(e):
    parts = []
    for a in getattr(e, "args", ()) or (str(e),):
        parts.append(a.decode("utf-8", "replace") if isinstance(a, bytes) else str(a))
    return " ".join(parts).strip() or e.__class__.__name__


def dh(value):
    if not value:
        return ""
    try:
        text = str(make_header(decode_header(value)))
    except Exception:
        text = value if isinstance(value, str) else str(value)
    return re.sub(r"\s+", " ", text).strip()


def connect(acc):
    host = acc["host"]
    port = int(acc.get("port") or 993)
    security = acc.get("security", "ssl")
    ctx = ssl.create_default_context()
    if security == "ssl":
        m = imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=CONNECT_TIMEOUT)
    else:
        m = imaplib.IMAP4(host, port, timeout=CONNECT_TIMEOUT)
        if security == "starttls":
            m.starttls(ctx)
    m._encoding = "utf-8"
    m.login(acc.get("username") or acc.get("email"), acc["password"])
    return m


def parse_fetch(account_id, data):
    """Turn imaplib FETCH data into message dicts."""
    msgs = []
    i = 0
    while i < len(data):
        item = data[i]
        i += 1
        if not isinstance(item, tuple):
            continue
        meta = item[0]
        trailing = b""
        if i < len(data) and isinstance(data[i], bytes):
            trailing = data[i]
        text = meta + b" " + trailing
        m = re.search(rb"UID (\d+)", text)
        if not m:
            continue
        uid = int(m.group(1))
        ts = 0
        try:
            t = imaplib.Internaldate2tuple(text)
            if t:
                ts = int(time.mktime(t))
        except Exception:
            pass
        hdr = message_from_bytes(item[1])
        if not ts:
            try:
                ts = int(parsedate_to_datetime(hdr.get("Date", "")).timestamp())
            except Exception:
                ts = int(time.time())
        name, addr = parseaddr(dh(hdr.get("From", "")))
        name = dh(name) or addr.split("@")[0] or "Unknown"
        msgs.append({
            "uid": uid,
            "account": account_id,
            "sender": name,
            "email": addr,
            "subject": dh(hdr.get("Subject", "")) or "(no subject)",
            "ts": ts,
        })
    return msgs


class Worker(threading.Thread):
    def __init__(self, acc):
        super().__init__(daemon=True)
        self.acc = acc
        self.id = acc["id"]
        self.cmds = queue.Queue()
        self.r, self.w = os.pipe()
        os.set_blocking(self.r, False)
        self.stopped = False
        self.known = None      # set of unread UIDs from last sync
        self.cache = {}        # uid -> message dict
        self.no_idle = False

    # -- control ---------------------------------------------------------
    def wake(self):
        try:
            os.write(self.w, b"x")
        except OSError:
            pass

    def send(self, cmd):
        self.cmds.put(cmd)
        self.wake()

    def stop(self):
        self.stopped = True
        self.wake()

    def _drain_pipe(self):
        try:
            while os.read(self.r, 1024):
                pass
        except (BlockingIOError, OSError):
            pass

    def _sleep(self, seconds):
        end = time.time() + seconds
        while not self.stopped and time.time() < end:
            select.select([self.r], [], [], min(1.0, end - time.time()))
            self._drain_pipe()

    # -- main loop -------------------------------------------------------
    def run(self):
        backoff = 5
        while not self.stopped:
            try:
                self.session()
                backoff = 5
            except Exception as e:  # noqa: BLE001
                if self.stopped:
                    break
                emit({"type": "status", "account": self.id, "state": "error",
                      "error": err_text(e)})
                self._sleep(backoff)
                backoff = min(backoff * 2, 300)

    def session(self):
        m = connect(self.acc)
        try:
            typ, data = m.select("INBOX")
            if typ != "OK":
                raise imaplib.IMAP4.error("Cannot open INBOX: " + err_text(Exception(*data)))
            emit({"type": "status", "account": self.id, "state": "connected"})
            can_idle = "IDLE" in getattr(m, "capabilities", ())
            self.no_idle = not can_idle
            self.sync(m)
            while not self.stopped:
                if self.process_cmds(m):
                    self.sync(m)
                if self.no_idle:
                    self._sleep(POLL_SECONDS)
                    if self.stopped:
                        break
                    m.noop()
                    self.process_cmds(m)
                    self.sync(m)
                else:
                    self.idle(m)
                    if not self.stopped:
                        self.sync(m)
        finally:
            try:
                m.logout()
            except Exception:
                pass

    def idle(self, m):
        tag = m._new_tag()
        m.send(tag + b" IDLE\r\n")
        line = m.readline()
        if not line.startswith(b"+"):
            # Server refused IDLE (line is the tagged NO/BAD): poll instead.
            self.no_idle = True
            return
        deadline = time.time() + IDLE_RENEW_SECONDS
        while not self.stopped:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            rl, _, _ = select.select([m.sock, self.r], [], [], remaining)
            if rl:
                break
        self._drain_pipe()
        m.send(b"DONE\r\n")
        while True:
            line = m.readline()
            if line.startswith(tag):
                break

    def process_cmds(self, m):
        did = False
        while True:
            try:
                cmd = self.cmds.get_nowait()
            except queue.Empty:
                return did
            did = True
            kind = cmd.get("cmd")
            if kind == "mark_read" and cmd.get("uids"):
                m.uid("STORE", ",".join(str(u) for u in cmd["uids"]),
                      "+FLAGS.SILENT", r"(\Seen)")
            elif kind == "mark_all_read":
                typ, data = m.uid("SEARCH", None, "UNSEEN")
                if typ == "OK" and data and data[0]:
                    m.uid("STORE", ",".join(data[0].decode().split()),
                          "+FLAGS.SILENT", r"(\Seen)")

    # -- sync ------------------------------------------------------------
    def sync(self, m):
        typ, data = m.uid("SEARCH", None, "UNSEEN")
        if typ != "OK":
            raise imaplib.IMAP4.error("SEARCH failed")
        uids = sorted(int(x) for x in (data[0] or b"").split())
        current = set(uids)
        recent = uids[-MAX_MESSAGES:]

        missing = [u for u in recent if u not in self.cache]
        for i in range(0, len(missing), 40):
            chunk = missing[i:i + 40]
            typ, fdata = m.uid(
                "FETCH", ",".join(str(u) for u in chunk),
                "(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            if typ == "OK":
                for msg in parse_fetch(self.id, fdata):
                    self.cache[msg["uid"]] = msg
        for u in list(self.cache):
            if u not in current:
                del self.cache[u]

        messages = sorted((self.cache[u] for u in recent if u in self.cache),
                          key=lambda x: x["ts"], reverse=True)
        emit({"type": "list", "account": self.id, "total": len(uids),
              "messages": messages})

        if self.known is not None:
            fresh = [self.cache[u] for u in uids
                     if u not in self.known and u in self.cache]
            if fresh:
                fresh.sort(key=lambda x: x["ts"])
                emit({"type": "new", "account": self.id, "messages": fresh})
        self.known = current


def run_test():
    acc = json.loads(sys.stdin.read())
    try:
        m = connect(acc)
        typ, data = m.select("INBOX", readonly=True)
        typ, s = m.uid("SEARCH", None, "UNSEEN")
        unseen = len((s[0] or b"").split())
        m.logout()
        print(json.dumps({"ok": True, "unseen": unseen}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": err_text(e)}))


def main():
    if "--test" in sys.argv:
        run_test()
        return
    workers = {}

    def stop_all():
        for w in workers.values():
            w.stop()
        workers.clear()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd = msg.get("cmd")
        if cmd == "config":
            stop_all()
            for acc in msg.get("accounts", []):
                w = Worker(acc)
                workers[acc["id"]] = w
                w.start()
        elif cmd == "refresh":
            for w in workers.values():
                w.send({"cmd": "refresh"})
        elif cmd in ("mark_read", "mark_all_read"):
            target = msg.get("account")
            for aid, w in workers.items():
                if target in (None, aid):
                    w.send(msg)
    stop_all()
    os._exit(0)


if __name__ == "__main__":
    main()
