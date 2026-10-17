#!/usr/bin/env python3
"""
Offline tests for notify.py.

No real credentials and no network: a local HTTP server stands in for Feishu,
Slack, Telegram and the WeCom webhook (the *_API_BASE overrides), and a local
websocket server stands in for the WeCom 智能机器人 (WECOM_WS_URL).

    python3 -m unittest discover -s tests -v
"""

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from email.parser import BytesParser
from email import policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import notify  # noqa: E402

try:
    import websockets
except ImportError:
    websockets = None

CHANNEL_ENVS = (
    "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_RECEIVE_ID", "FEISHU_RECEIVE_ID_TYPE",
    "FEISHU_API_BASE", "FEISHU_CHANNEL",
    "SLACK_BOT_TOKEN", "SLACK_CHANNEL", "SLACK_API_BASE",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_API_BASE", "TELEGRAM_CHANNEL",
    "WECOM_WEBHOOK_KEY", "WECOM_API_BASE", "WECOM_CHANNEL",
    "WECOM_BOT_ID", "WECOM_BOT_SECRET", "WECOM_CHAT_ID", "WECOM_CHAT_TYPE", "WECOM_WS_URL",
    "HALO_WORKSPACE",
)
SECRETS = ("feishu-secret", "xoxb-secret", "123456:tg-secret", "wecom-key", "bot-secret", "aib-bot-id")
MP3 = b"ID3\x04\x00fake-mp3-bytes"


class Fake(BaseHTTPRequestHandler):
    """One server for every HTTP API; the response is picked by the last path segment."""
    calls = []        # {"method", "path", "headers", "body"}
    override = {}     # segment -> dict | (status, dict)
    base = ""

    def log_message(self, *a):
        pass

    def defaults(self, name, body):
        if name == "internal":
            ok = json.loads(body).get("app_secret") == "feishu-secret"
            return {"code": 0, "tenant_access_token": "t-123"} if ok else \
                {"code": 10014, "msg": "app secret invalid: " + json.loads(body).get("app_secret", "")}
        if name == "messages":
            return {"code": 0, "data": {"message_id": "om_fake"}}
        if name == "files":
            return {"code": 0, "data": {"file_key": "file_fake"}}
        if name in ("chat.postMessage", "files.completeUploadExternal"):
            ok = self.headers.get("Authorization") == "Bearer xoxb-secret"
            return {"ok": True} if ok else {"ok": False, "error": "invalid_auth"}
        if name == "conversations.open":
            return {"ok": True, "channel": {"id": "D0DM"}}
        if name == "files.getUploadURLExternal":
            return {"ok": True, "file_id": "F1", "upload_url": f"{Fake.base}/slack-upload/F1?sig=up-secret"}
        if name == "F1":
            return {"ok": True}
        if name in ("sendMessage", "sendAudio", "sendDocument"):
            return {"ok": True, "result": {}} if "tg-secret" in self.path else \
                {"ok": False, "error_code": 401, "description": "Unauthorized"}
        if name == "send":
            return {"errcode": 0, "errmsg": "ok"}
        if name == "upload_media":
            return {"errcode": 0, "errmsg": "ok", "media_id": "media_fake"}
        return {"code": -1, "ok": False, "errcode": -1}

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        Fake.calls.append({"method": "POST", "path": self.path, "headers": dict(self.headers), "body": body})
        name = self.path.split("?")[0].rsplit("/", 1)[-1]
        out = Fake.override.get(name) or self.defaults(name, body)
        status, out = out if isinstance(out, tuple) else (200, out)
        raw = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    @staticmethod
    def named(name):
        return [c for c in Fake.calls if c["path"].split("?")[0].rsplit("/", 1)[-1] == name]


def jbody(call):
    return json.loads(call["body"])


def multipart(call):
    """-> {field: (filename | None, bytes)}"""
    raw = b"Content-Type: " + call["headers"]["Content-Type"].encode() + b"\r\n\r\n" + call["body"]
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    return {p.get_param("name", header="content-disposition"): (p.get_filename(), p.get_payload(decode=True))
            for p in msg.iter_parts()}


class FakeBot:
    """Minimal openws.work.weixin.qq.com: acks by req_id, like the real one."""
    frames = []
    mode = "ok"              # ok | noisy (callbacks before acks) | kicked | silent
    send_errcode = 0
    fail = {}                # cmd -> errcode to answer with instead of 0
    uploads = {}             # upload_id -> {"init": body, "chunks": {index: bytes}}

    @classmethod
    async def handler(cls, ws):
        try:
            async for raw in ws:
                m = json.loads(raw)
                cls.frames.append(m)
                rid = m["headers"]["req_id"]
                if cls.mode == "silent":
                    continue
                if cls.mode == "noisy":
                    await ws.send(json.dumps({"cmd": "aibot_msg_callback", "headers": {"req_id": "other"}}))
                    await ws.send("not json")
                if cls.mode == "kicked" and m["cmd"] == "aibot_send_msg":
                    await ws.send(json.dumps({"cmd": "aibot_event_callback", "headers": {"req_id": "e"},
                                              "body": {"event": {"eventtype": "disconnected_event"}}}))
                    continue
                if m["cmd"] in cls.fail:
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "errcode": cls.fail[m["cmd"]],
                                              "errmsg": "upload rejected"}))
                    continue
                if m["cmd"] == "aibot_upload_media_init":
                    uid = f"up{len(cls.uploads) + 1}"
                    cls.uploads[uid] = {"init": m["body"], "chunks": {}}
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "body": {"upload_id": uid},
                                              "errcode": 0, "errmsg": "ok"}))
                elif m["cmd"] == "aibot_upload_media_chunk":
                    b = m["body"]
                    cls.uploads[b["upload_id"]]["chunks"][b["chunk_index"]] = base64.b64decode(b["base64_data"])
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "errcode": 0, "errmsg": "ok"}))
                elif m["cmd"] == "aibot_upload_media_finish":
                    uid = m["body"]["upload_id"]
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "errcode": 0, "errmsg": "ok",
                                              "body": {"type": "file", "media_id": "mid_" + uid, "created_at": "1"}}))
                elif m["cmd"] == "aibot_subscribe":
                    ok = m["body"].get("secret") == "bot-secret"
                    # The real errmsg does not echo the secret; this one does, to test scrubbing.
                    msg = "ok" if ok else f"invalid bot_id or secret {m['body'].get('secret')}"
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "errcode": 0 if ok else 853000,
                                              "errmsg": msg}))
                else:
                    code = cls.send_errcode
                    await ws.send(json.dumps({"headers": {"req_id": rid}, "errcode": code,
                                              "errmsg": "ok" if not code else "no conversation"}))
        except websockets.exceptions.ConnectionClosed:
            pass

    @classmethod
    def start(cls):
        ready, cls._stop_holder = threading.Event(), {}

        async def main():
            stop = asyncio.Event()
            cls._stop_holder.update(loop=asyncio.get_running_loop(), stop=stop)
            async with websockets.serve(cls.handler, "127.0.0.1", 0) as server:
                cls.url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
                ready.set()
                await stop.wait()

        threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
        ready.wait(10)

    @classmethod
    def stop(cls):
        cls._stop_holder["loop"].call_soon_threadsafe(cls._stop_holder["stop"].set)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        cls.base = Fake.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        if websockets:
            FakeBot.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        if websockets:
            FakeBot.stop()

    def setUp(self):
        Fake.calls.clear()
        Fake.override.clear()
        FakeBot.frames.clear()
        FakeBot.mode, FakeBot.send_errcode = "ok", 0
        FakeBot.fail.clear()
        FakeBot.uploads.clear()
        notify._runtime_secrets.clear()
        patches = [mock.patch.dict(os.environ), mock.patch.object(notify, "CHUNK_DELAY", 0),
                   mock.patch.object(notify, "WECOM_WEBHOOK_DELAY", 0)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for k in CHANNEL_ENVS:
            os.environ.pop(k, None)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="notify-ws-"))
        os.environ["HALO_WORKSPACE"] = self.ws

    def file(self, name="a.mp3", data=MP3, where=None):
        path = os.path.join(where or self.ws, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def run_main(self, text="", argv=()):
        """notify.main() in-process -> (exit code, [json lines], stdout + stderr)"""
        out, err = io.StringIO(), io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(text.encode("utf-8")))
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = notify.main(list(argv))
        return code, [json.loads(l) for l in out.getvalue().splitlines()], out.getvalue() + err.getvalue()

    # one helper per channel: put its env vars in place
    def feishu_on(self, **extra):
        os.environ.update(FEISHU_APP_ID="cli_x", FEISHU_APP_SECRET="feishu-secret", FEISHU_RECEIVE_ID="oc_x",
                          FEISHU_API_BASE=self.base, **extra)

    def slack_on(self, channel="C0123"):
        os.environ.update(SLACK_BOT_TOKEN="xoxb-secret", SLACK_CHANNEL=channel, SLACK_API_BASE=self.base + "/slack")

    def telegram_on(self):
        os.environ.update(TELEGRAM_BOT_TOKEN="123456:tg-secret", TELEGRAM_CHAT_ID="42", TELEGRAM_API_BASE=self.base + "/tg")

    def webhook_on(self):
        os.environ.update(WECOM_WEBHOOK_KEY="wecom-key", WECOM_API_BASE=self.base)

    def bot_on(self):
        os.environ.update(WECOM_BOT_ID="aib-bot-id", WECOM_BOT_SECRET="bot-secret", WECOM_CHAT_ID="zhangsan",
                          WECOM_WS_URL=FakeBot.url)


# ---------------------------------------------------------------- unit tests


class Split(unittest.TestCase):
    def test_never_over_limit_and_lossless(self):
        text = "\n".join(f"- 第{i}行 资源 arn:aws:rds:ap-northeast-1:1:db/x{i} 维护待处理" for i in range(400))
        for size in (notify._chars, notify._bytes):
            for limit in (100, 1000, 4080):
                parts = notify.split_text(text, limit, size)
                self.assertTrue(all(size(p) <= limit for p in parts))
                self.assertEqual("".join(parts).replace("\n", ""), text.replace("\n", ""))

    def test_long_line_cut_on_char_boundary(self):
        line = "中" * 3000  # 9000 bytes, no newline
        parts = notify.split_text(line, 4080, notify._bytes)
        self.assertEqual("".join(parts), line)
        self.assertTrue(all(len(p.encode()) <= 4080 for p in parts))

    def test_chunk_message_prefix_only_when_split(self):
        self.assertEqual(notify.chunk_message("hello", 100, notify._chars), ["hello"])
        parts = notify.chunk_message("\n".join("x" * 50 for _ in range(10)), 200, notify._chars)
        self.assertGreater(len(parts), 1)
        self.assertTrue(parts[0].startswith(f"(1/{len(parts)})\n"))
        self.assertTrue(all(len(p) <= 200 for p in parts))

    def test_blank_text_has_no_chunks(self):
        self.assertEqual(notify.chunk_message("", 100, notify._chars), [])

    def test_webhook_delay_respects_20_per_minute(self):
        self.assertGreaterEqual(notify.WECOM_WEBHOOK_DELAY, 3.0)


class Media(Base):
    def test_accepts_files_under_the_workspace(self):
        a, b = self.file("a.mp3"), self.file("sub/b.txt", b"x")
        text, media = notify.extract_media(f"hello\nMEDIA:{a}\n\nMEDIA: {b}  \nbye")
        self.assertEqual((text, media), ("hello\n\nbye", [a, b]))

    def test_rejected_lines_stay_visible(self):
        outside = self.file("o.mp3", where=tempfile.mkdtemp(prefix="notify-out-"))
        sibling = self.file("s.mp3", where=self.ws + "-other")
        link = os.path.join(self.ws, "link.mp3")
        os.symlink(outside, link)
        lines = [f"MEDIA:{outside}", f"MEDIA:{sibling}", f"MEDIA:{link}", f"MEDIA:{self.ws}",
                 f"MEDIA:{self.ws}/missing.mp3", "MEDIA:relative.mp3", f"see MEDIA:{outside}"]
        text, media = notify.extract_media("\n".join(lines))
        self.assertEqual(media, [])
        self.assertEqual(text.splitlines(), lines)

    def test_without_workspace_any_regular_file_is_allowed(self):
        del os.environ["HALO_WORKSPACE"]
        p = self.file("a.mp3", where=tempfile.mkdtemp(prefix="notify-any-"))
        self.assertEqual(notify.extract_media(f"MEDIA:{p}"), ("", [p]))
        self.assertEqual(notify.extract_media("MEDIA:/nonexistent/x.mp3")[1], [])

    def test_crlf_and_duplicates(self):
        p = self.file()
        self.assertEqual(notify.extract_media(f"a\r\nMEDIA:{p}\r\nMEDIA:{p}\r\nb"), ("a\nb", [p]))


class Scrub(Base):
    def test_all_configured_secrets_and_runtime_tokens_are_masked(self):
        self.feishu_on()
        self.slack_on()
        self.telegram_on()
        self.webhook_on()
        self.bot_on()
        notify._runtime_secrets.append("t-runtime")
        msg = " ".join(SECRETS + ("t-runtime", "123456%3Atg-secret"))
        self.assertNotRegex(notify._scrub(msg), "|".join(map(re.escape, SECRETS + ("t-runtime",))))

    def test_webhook_key_given_as_full_url(self):
        os.environ["WECOM_WEBHOOK_KEY"] = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key"
        self.assertEqual(notify._webhook_key(), "wecom-key")
        self.assertEqual(notify._scrub("failed for key wecom-key"), "failed for key ***")


# ------------------------------------------------------------- channel select


class Select(Base):
    def names(self):
        return [c.name for c in notify.enabled_channels()]

    def test_matrix_follows_the_env(self):
        self.assertEqual(self.names(), [])
        self.feishu_on()
        self.assertEqual(self.names(), ["feishu"])
        self.slack_on()
        self.telegram_on()
        self.webhook_on()
        self.bot_on()
        self.assertEqual(self.names(), ["feishu", "slack", "telegram", "wecom_webhook", "wecom_bot"])

    def test_partial_config_is_not_enough_and_is_logged(self):
        os.environ.update(FEISHU_APP_ID="cli_x", FEISHU_APP_SECRET="feishu-secret", TELEGRAM_BOT_TOKEN="1:tg-secret")
        os.environ.update(WECOM_BOT_ID="aib-bot-id")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(self.names(), [])
        self.assertIn("feishu: FEISHU_RECEIVE_ID not set", err.getvalue())
        self.assertIn("telegram: TELEGRAM_CHAT_ID not set", err.getvalue())
        self.assertNotIn("slack", err.getvalue())  # nothing of it set -> nothing to say
        for s in ("feishu-secret", "tg-secret", "aib-bot-id"):
            self.assertNotIn(s, err.getvalue())

    def test_off_switches(self):
        self.feishu_on()
        self.slack_on()
        self.telegram_on()
        self.webhook_on()
        self.bot_on()
        os.environ["FEISHU_CHANNEL"] = "off"
        os.environ["SLACK_CHANNEL"] = "OFF"          # the Slack target var doubles as its switch
        os.environ["TELEGRAM_CHANNEL"] = " Off "
        self.assertEqual(self.names(), ["wecom_webhook", "wecom_bot"])
        os.environ["WECOM_CHANNEL"] = "OFF"          # one switch for both WeCom channels
        self.assertEqual(self.names(), [])

    def test_no_channel_exits_2(self):
        code, lines, _ = self.run_main("hello")
        self.assertEqual((code, lines[0]["ok"], lines[0]["error"]), (2, False, "no channel configured"))
        self.assertEqual(Fake.calls, [])


# --------------------------------------------------------------------- feishu


class Feishu(Base):
    def test_text_goes_out_with_token(self):
        self.feishu_on()
        code, lines, _ = self.run_main("# 巡检\n- 无")
        self.assertEqual((code, lines), (0, [{"channel": "feishu", "ok": True, "messages": 1, "attachments": 0}]))
        tok = jbody(Fake.named("internal")[0])
        self.assertEqual(tok, {"app_id": "cli_x", "app_secret": "feishu-secret"})
        msg = Fake.named("messages")[0]
        self.assertIn("receive_id_type=chat_id", msg["path"])
        self.assertEqual(msg["headers"]["Authorization"], "Bearer t-123")
        self.assertEqual(jbody(msg)["receive_id"], "oc_x")
        self.assertEqual(jbody(msg)["msg_type"], "text")
        self.assertEqual(json.loads(jbody(msg)["content"]), {"text": "# 巡检\n- 无"})

    def test_receive_id_type_override(self):
        self.feishu_on(FEISHU_RECEIVE_ID_TYPE="open_id")
        self.run_main("x")
        self.assertIn("receive_id_type=open_id", Fake.named("messages")[0]["path"])

    def test_long_text_is_split_at_4500_chars(self):
        self.feishu_on()
        self.run_main("\n".join("字" * 99 for _ in range(100)))  # ~9.9k chars
        texts = [json.loads(jbody(c)["content"])["text"] for c in Fake.named("messages")]
        self.assertEqual(len(texts), 3)
        self.assertTrue(all(len(t) <= 4500 for t in texts))
        self.assertTrue(texts[0].startswith("(1/3)\n") and texts[2].startswith("(3/3)\n"))

    def test_mp3_is_uploaded_then_sent_as_file(self):
        self.feishu_on()
        mp3 = self.file()
        code, lines, _ = self.run_main(f"today's lesson\nMEDIA:{mp3}")
        self.assertEqual((code, lines[0]["messages"], lines[0]["attachments"]), (0, 1, 1))
        up = Fake.named("files")[0]
        self.assertEqual(up["headers"]["Authorization"], "Bearer t-123")
        fields = multipart(up)
        self.assertEqual(fields["file_type"][1], b"stream")
        self.assertEqual(fields["file_name"][1], b"a.mp3")
        self.assertEqual(fields["file"], ("a.mp3", MP3))
        sends = [jbody(c) for c in Fake.named("messages")]
        self.assertEqual([s["msg_type"] for s in sends], ["text", "file"])
        self.assertEqual(json.loads(sends[1]["content"]), {"file_key": "file_fake"})

    def test_token_error_is_scrubbed(self):
        self.feishu_on()
        os.environ["FEISHU_APP_SECRET"] = "wrong-secret"
        code, lines, raw = self.run_main("x")
        self.assertEqual((code, lines[0]["ok"]), (1, False))
        self.assertIn("token: code 10014", lines[0]["error"])
        self.assertNotIn("wrong-secret", raw)
        self.assertEqual(Fake.named("messages"), [])

    def test_send_error_reported_with_code(self):
        self.feishu_on()
        Fake.override["messages"] = {"code": 230013, "msg": "Bot has NO availability to this user."}
        code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("send: code 230013 Bot has NO availability", lines[0]["error"])

    def test_upload_failure_keeps_text_and_fails_channel(self):
        self.feishu_on()
        Fake.override["files"] = {"code": 99991672, "msg": "Access denied. scope im:resource:upload"}
        code, lines, _ = self.run_main(f"hi\nMEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["ok"], lines[0]["messages"], lines[0]["attachments"]), (1, False, 1, 0))
        self.assertIn("a.mp3: upload: code 99991672", lines[0]["error"])


# ---------------------------------------------------------------------- slack


class Slack(Base):
    def test_post_message(self):
        self.slack_on()
        code, lines, _ = self.run_main("a < b & c > d")
        self.assertEqual((code, lines), (0, [{"channel": "slack", "ok": True, "messages": 1, "attachments": 0}]))
        call = Fake.named("chat.postMessage")[0]
        self.assertEqual(call["headers"]["Authorization"], "Bearer xoxb-secret")
        self.assertEqual(jbody(call), {"channel": "C0123", "text": "a &lt; b &amp; c &gt; d"})  # no <!channel> pings

    def test_long_text_split_at_4000(self):
        self.slack_on()
        self.run_main("\n".join("x" * 99 for _ in range(100)))
        texts = [jbody(c)["text"] for c in Fake.named("chat.postMessage")]
        self.assertEqual(len(texts), 3)
        self.assertTrue(all(len(t) <= 4000 for t in texts))

    def test_mp3_uses_the_v2_upload_flow(self):
        self.slack_on()
        mp3 = self.file()
        code, lines, _ = self.run_main(f"hi\nMEDIA:{mp3}")
        self.assertEqual((code, lines[0]["attachments"]), (0, 1))
        paths = [c["path"].split("?")[0].rsplit("/", 1)[-1] for c in Fake.calls]
        self.assertEqual(paths, ["chat.postMessage", "files.getUploadURLExternal", "F1", "files.completeUploadExternal"])
        step1 = Fake.named("files.getUploadURLExternal")[0]
        self.assertEqual(step1["headers"]["Authorization"], "Bearer xoxb-secret")
        self.assertEqual(step1["body"], f"filename=a.mp3&length={len(MP3)}".encode())
        put = Fake.named("F1")[0]
        self.assertEqual(put["body"], MP3)
        self.assertNotIn("Authorization", put["headers"])  # the signed URL is the credential
        self.assertEqual(jbody(Fake.named("files.completeUploadExternal")[0]),
                         {"files": [{"id": "F1", "title": "a.mp3"}], "channel_id": "C0123"})

    def test_user_id_target_opens_the_dm_for_the_upload_only(self):
        self.slack_on("U0ABC")
        self.run_main(f"hi\nMEDIA:{self.file()}")
        self.assertEqual(jbody(Fake.named("chat.postMessage")[0])["channel"], "U0ABC")  # Slack opens the DM itself
        self.assertEqual(jbody(Fake.named("conversations.open")[0]), {"users": "U0ABC"})
        self.assertEqual(jbody(Fake.named("files.completeUploadExternal")[0])["channel_id"], "D0DM")

    def test_no_dm_lookup_without_attachments(self):
        self.slack_on("U0ABC")
        self.run_main("hi")
        self.assertEqual(Fake.named("conversations.open"), [])

    def test_api_error_names_the_method_and_scrubs_the_token(self):
        self.slack_on()
        Fake.override["chat.postMessage"] = {"ok": False, "error": "not_in_channel xoxb-secret"}
        code, lines, raw = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("chat.postMessage: not_in_channel", lines[0]["error"])
        self.assertNotIn("xoxb-secret", raw)

    def test_missing_scope_is_spelled_out(self):
        self.slack_on()
        Fake.override["files.getUploadURLExternal"] = {"ok": False, "error": "missing_scope", "needed": "files:write"}
        code, lines, _ = self.run_main(f"hi\nMEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["messages"], lines[0]["attachments"]), (1, 1, 0))
        self.assertIn("missing_scope (needed scope: files:write)", lines[0]["error"])

    def test_upload_url_put_failure(self):
        self.slack_on()
        Fake.override["F1"] = (500, {"ok": False})
        code, lines, raw = self.run_main(f"MEDIA:{self.file()}")
        self.assertEqual(code, 1)
        self.assertIn("upload_url: HTTP 500", lines[0]["error"])
        self.assertNotIn("up-secret", raw)
        self.assertEqual(Fake.named("files.completeUploadExternal"), [])


# ------------------------------------------------------------------- telegram


class Telegram(Base):
    def test_send_message(self):
        self.telegram_on()
        code, lines, _ = self.run_main("hello 你好")
        self.assertEqual((code, lines), (0, [{"channel": "telegram", "ok": True, "messages": 1, "attachments": 0}]))
        call = Fake.named("sendMessage")[0]
        self.assertTrue(call["path"].startswith("/tg/bot123456:tg-secret/"))
        self.assertEqual(jbody(call), {"chat_id": "42", "text": "hello 你好"})  # plain text, no parse_mode

    def test_long_text_split_at_4000(self):
        self.telegram_on()
        self.run_main("\n".join("x" * 99 for _ in range(100)))
        texts = [jbody(c)["text"] for c in Fake.named("sendMessage")]
        self.assertEqual(len(texts), 3)
        self.assertTrue(all(len(t) <= 4000 for t in texts))

    def test_mp3_is_sent_as_audio_other_files_as_documents(self):
        self.telegram_on()
        mp3, txt = self.file(), self.file("notes.txt", b"hello")
        code, lines, _ = self.run_main(f"hi\nMEDIA:{mp3}\nMEDIA:{txt}")
        self.assertEqual((code, lines[0]["attachments"]), (0, 2))
        audio, doc = Fake.named("sendAudio")[0], Fake.named("sendDocument")[0]
        self.assertEqual(multipart(audio)["chat_id"][1], b"42")
        self.assertEqual(multipart(audio)["audio"], ("a.mp3", MP3))
        self.assertEqual(multipart(doc)["document"], ("notes.txt", b"hello"))

    def test_403_explains_the_user_must_message_the_bot_first(self):
        self.telegram_on()
        Fake.override["sendMessage"] = (403, {"ok": False, "error_code": 403,
                                              "description": "Forbidden: bot can't initiate conversation with a user"})
        code, lines, _ = self.run_main("x")
        self.assertEqual((code, lines[0]["ok"]), (1, False))
        self.assertIn("403", lines[0]["error"])
        self.assertIn("messaged the bot at least once", lines[0]["error"])

    def test_bad_token_error(self):
        self.telegram_on()
        os.environ["TELEGRAM_BOT_TOKEN"] = "123456:wrong"
        code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("sendMessage: 401 Unauthorized", lines[0]["error"])

    def test_unreachable_api_does_not_leak_the_token(self):
        self.telegram_on()
        os.environ["TELEGRAM_API_BASE"] = "http://127.0.0.1:9"
        code, lines, raw = self.run_main("x")
        self.assertEqual((code, lines[0]["ok"]), (1, False))
        self.assertNotIn("tg-secret", raw)


# -------------------------------------------------------------- wecom webhook


class WecomWebhook(Base):
    def test_markdown_v2_with_key_in_query(self):
        self.webhook_on()
        code, lines, _ = self.run_main("# 巡检\n- 无")
        self.assertEqual((code, lines), (0, [{"channel": "wecom_webhook", "ok": True, "messages": 1, "attachments": 0}]))
        call = Fake.named("send")[0]
        self.assertEqual(call["path"], "/cgi-bin/webhook/send?key=wecom-key")
        self.assertEqual(jbody(call), {"msgtype": "markdown_v2", "markdown_v2": {"content": "# 巡检\n- 无"}})

    def test_long_text_split_at_4096_bytes(self):
        self.webhook_on()
        self.run_main("\n".join("好" * 100 for _ in range(60)))  # 18 KB
        parts = [jbody(c)["markdown_v2"]["content"] for c in Fake.named("send")]
        self.assertGreater(len(parts), 3)
        self.assertTrue(all(len(p.encode()) <= 4096 for p in parts))

    def test_file_is_uploaded_then_sent_by_media_id(self):
        self.webhook_on()
        code, lines, _ = self.run_main(f"hi\nMEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["attachments"]), (0, 1))
        up = Fake.named("upload_media")[0]
        self.assertEqual(up["path"], "/cgi-bin/webhook/upload_media?key=wecom-key&type=file")
        self.assertEqual(multipart(up)["media"], ("a.mp3", MP3))
        self.assertEqual(jbody(Fake.named("send")[1]), {"msgtype": "file", "file": {"media_id": "media_fake"}})

    def test_errcode_reported_and_key_scrubbed(self):
        self.webhook_on()
        Fake.override["send"] = {"errcode": 93000, "errmsg": "invalid webhook url, key wecom-key"}
        code, lines, raw = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("errcode 93000", lines[0]["error"])
        self.assertNotIn("wecom-key", raw)

    def test_full_webhook_url_as_key(self):
        os.environ.update(WECOM_API_BASE=self.base,
                          WECOM_WEBHOOK_KEY="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key")
        self.assertEqual(self.run_main("x")[0], 0)
        self.assertEqual(Fake.named("send")[0]["path"], "/cgi-bin/webhook/send?key=wecom-key")


# ---------------------------------------------------------------- wecom bot


@unittest.skipUnless(websockets, "websockets is not installed")
class WecomBot(Base):
    def sent(self):
        return [f for f in FakeBot.frames if f["cmd"] == "aibot_send_msg"]

    def test_frames_match_the_protocol(self):
        self.bot_on()
        code, lines, _ = self.run_main("# 巡检\n- 无")
        self.assertEqual((code, lines), (0, [{"channel": "wecom_bot", "ok": True, "messages": 1, "attachments": 0}]))
        sub, send = FakeBot.frames
        self.assertEqual(sub["cmd"], "aibot_subscribe")
        self.assertEqual(sub["body"], {"bot_id": "aib-bot-id", "secret": "bot-secret"})
        self.assertRegex(sub["headers"]["req_id"], r"^aibot_subscribe_\d{13}_[0-9a-f]{8}$")
        self.assertEqual(send["body"], {"chatid": "zhangsan", "chat_type": 1, "msgtype": "markdown",
                                        "markdown": {"content": "# 巡检\n- 无"}})
        self.assertNotEqual(sub["headers"]["req_id"], send["headers"]["req_id"])

    def test_group_chat_type_and_validation(self):
        self.bot_on()
        os.environ.update(WECOM_CHAT_TYPE="2", WECOM_CHAT_ID="wrk-group")
        self.assertEqual(self.run_main("x")[0], 0)
        self.assertEqual(self.sent()[0]["body"]["chat_type"], 2)
        FakeBot.frames.clear()
        os.environ["WECOM_CHAT_TYPE"] = "9"
        code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("WECOM_CHAT_TYPE", lines[0]["error"])
        self.assertEqual(FakeBot.frames, [])

    def test_long_text_is_chunked_at_20480_bytes_over_one_connection(self):
        self.bot_on()
        self.run_main("\n".join("巡" * 100 for _ in range(100)))  # ~30 KB
        parts = [f["body"]["markdown"]["content"] for f in self.sent()]
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(len(p.encode()) <= 20480 for p in parts))
        self.assertTrue(parts[0].startswith("(1/2)\n") and parts[1].startswith("(2/2)\n"))
        self.assertEqual(sum(f["cmd"] == "aibot_subscribe" for f in FakeBot.frames), 1)

    def test_mp3_is_uploaded_then_sent_as_a_file_message(self):
        self.bot_on()
        mp3 = self.file()
        code, lines, _ = self.run_main(f"today's lesson\nMEDIA:{mp3}")
        self.assertEqual((code, lines), (0, [{"channel": "wecom_bot", "ok": True, "messages": 1, "attachments": 1}]))
        self.assertEqual([f["cmd"] for f in FakeBot.frames], [
            "aibot_subscribe", "aibot_send_msg", "aibot_upload_media_init", "aibot_upload_media_chunk",
            "aibot_upload_media_finish", "aibot_send_msg"])
        init = FakeBot.frames[2]
        self.assertRegex(init["headers"]["req_id"], r"^aibot_upload_media_init_\d{13}_[0-9a-f]{8}$")
        self.assertEqual(init["body"], {"type": "file", "filename": "a.mp3", "total_size": len(MP3), "total_chunks": 1,
                                        "md5": hashlib.md5(MP3).hexdigest()})
        chunk = FakeBot.frames[3]["body"]
        self.assertEqual((chunk["upload_id"], chunk["chunk_index"]), ("up1", 0))
        self.assertEqual(FakeBot.uploads["up1"]["chunks"], {0: MP3})
        self.assertEqual(FakeBot.frames[4]["body"], {"upload_id": "up1"})
        self.assertEqual(FakeBot.frames[5]["body"], {"chatid": "zhangsan", "chat_type": 1, "msgtype": "file",
                                                     "file": {"media_id": "mid_up1"}})
        self.assertEqual(sum(f["cmd"] == "aibot_subscribe" for f in FakeBot.frames), 1)

    def test_big_file_is_cut_into_512k_chunks(self):
        self.bot_on()
        data = (bytes(range(256)) * 2100)[:notify.WECOM_UPLOAD_CHUNK + 777]  # one full chunk + 777 B
        self.assertEqual(self.run_main(f"MEDIA:{self.file('big.bin', data)}")[0], 0)
        up = FakeBot.uploads["up1"]
        self.assertEqual((up["init"]["total_chunks"], up["init"]["total_size"]), (2, len(data)))
        self.assertEqual([len(up["chunks"][i]) for i in (0, 1)], [notify.WECOM_UPLOAD_CHUNK, 777])
        self.assertEqual(b"".join(up["chunks"][i] for i in (0, 1)), data)
        self.assertEqual(up["init"]["md5"], hashlib.md5(data).hexdigest())

    def test_several_attachments_are_uploaded_one_after_another(self):
        self.bot_on()
        a, b = self.file("a.mp3"), self.file("b.txt", b"hello")
        code, lines, _ = self.run_main(f"hi\nMEDIA:{a}\nMEDIA:{b}")
        self.assertEqual((code, lines[0]["attachments"]), (0, 2))
        self.assertEqual([u["init"]["filename"] for u in FakeBot.uploads.values()], ["a.mp3", "b.txt"])
        files = [f["body"]["file"]["media_id"] for f in self.sent() if f["body"]["msgtype"] == "file"]
        self.assertEqual(files, ["mid_up1", "mid_up2"])

    def test_attachment_only_run_sends_no_text(self):
        self.bot_on()
        code, lines, _ = self.run_main(f"MEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["messages"], lines[0]["attachments"]), (0, 0, 1))
        self.assertEqual([f["body"]["msgtype"] for f in self.sent()], ["file"])

    def test_failed_upload_leaves_a_visible_note_in_the_chat(self):
        self.bot_on()
        FakeBot.fail["aibot_upload_media_chunk"] = 40058
        code, lines, _ = self.run_main(f"today's lesson\nMEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["ok"], lines[0]["attachments"], lines[0]["messages"]), (1, False, 0, 2))
        self.assertIn("a.mp3: upload chunk 1/1: errcode 40058", lines[0]["error"])
        first, note = [f["body"] for f in self.sent()]
        self.assertEqual(first["markdown"]["content"], "today's lesson")
        self.assertEqual(note["msgtype"], "markdown")
        self.assertIn("[attachment not sent: a.mp3 -- upload chunk 1/1: errcode 40058", note["markdown"]["content"])
        self.assertNotIn("aibot_upload_media_finish", [f["cmd"] for f in FakeBot.frames])

    def test_init_and_finish_failures_are_reported_too(self):
        self.bot_on()
        for cmd, step in (("aibot_upload_media_init", "upload init"), ("aibot_upload_media_finish", "upload finish")):
            FakeBot.fail.clear()
            FakeBot.fail[cmd] = 846607
            code, lines, _ = self.run_main(f"MEDIA:{self.file()}")
            self.assertEqual(code, 1)
            self.assertIn(f"{step}: errcode 846607", lines[0]["error"])

    def test_one_bad_file_does_not_stop_the_next(self):
        self.bot_on()
        tiny = self.file("tiny.txt", b"abc")  # WeCom needs >= 5 bytes: rejected locally, no frames for it
        good = self.file("good.mp3")
        code, lines, _ = self.run_main(f"MEDIA:{tiny}\nMEDIA:{good}")
        self.assertEqual((code, lines[0]["attachments"]), (1, 1))
        self.assertIn("tiny.txt: file is 3 bytes", lines[0]["error"])
        self.assertEqual([u["init"]["filename"] for u in FakeBot.uploads.values()], ["good.mp3"])
        self.assertTrue(any("attachment not sent: tiny.txt" in f["body"].get("markdown", {}).get("content", "")
                            for f in self.sent()))

    def test_file_over_20mb_is_not_uploaded(self):
        self.bot_on()
        path = self.file("huge.bin", b"")
        with open(path, "r+b") as f:
            f.truncate(notify.WECOM_FILE_MAX + 1)  # sparse
        code, lines, _ = self.run_main(f"MEDIA:{path}")
        self.assertEqual(code, 1)
        self.assertIn("huge.bin: file is 20971521 bytes", lines[0]["error"])
        self.assertEqual(FakeBot.uploads, {})

    def test_kicked_during_upload_still_fails_cleanly(self):
        self.bot_on()
        FakeBot.mode = "kicked"
        code, lines, _ = self.run_main(f"MEDIA:{self.file()}")
        self.assertEqual(code, 1)
        self.assertEqual(lines[0]["attachments"], 0)

    def test_callbacks_and_garbage_before_the_ack_are_skipped(self):
        self.bot_on()
        FakeBot.mode = "noisy"
        self.assertEqual(self.run_main("x")[0], 0)

    def test_subscribe_failure_scrubs_secret(self):
        self.bot_on()
        os.environ["WECOM_BOT_SECRET"] = "wrong-bot-secret"
        code, lines, raw = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("subscribe: errcode 853000", lines[0]["error"])
        self.assertNotIn("wrong-bot-secret", raw)
        self.assertEqual([f["cmd"] for f in FakeBot.frames], ["aibot_subscribe"])

    def test_send_errcode_reported(self):
        self.bot_on()
        FakeBot.send_errcode = 846609
        code, lines, _ = self.run_main("x")
        self.assertEqual((code, lines[0]["messages"]), (1, 0))
        self.assertIn("send: errcode 846609", lines[0]["error"])

    def test_kicked_by_another_connection(self):
        self.bot_on()
        FakeBot.mode = "kicked"
        code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("disconnected_event", lines[0]["error"])

    def test_no_ack_times_out(self):
        self.bot_on()
        FakeBot.mode = "silent"
        with mock.patch.object(notify, "WS_TIMEOUT", 0.5):
            code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        self.assertIn("TimeoutError: no ack for aibot_subscribe", lines[0]["error"])

    def test_unreachable_does_not_leak_secrets(self):
        self.bot_on()
        os.environ["WECOM_WS_URL"] = "ws://127.0.0.1:9/bot-secret"
        code, lines, raw = self.run_main("x")
        self.assertEqual((code, lines[0]["ok"]), (1, False))
        self.assertNotIn("bot-secret", raw)


class WecomBotWithoutWebsockets(Base):
    def test_missing_module_fails_only_that_channel(self):
        self.bot_on()
        self.webhook_on()
        with mock.patch.dict(sys.modules, {"websockets": None}):
            code, lines, _ = self.run_main("x")
        self.assertEqual(code, 1)
        by = {l["channel"]: l for l in lines}
        self.assertTrue(by["wecom_webhook"]["ok"])
        self.assertFalse(by["wecom_bot"]["ok"])
        self.assertIn("python3-websockets", by["wecom_bot"]["error"])


# ------------------------------------------------------------------------ CLI


class Cli(Base):
    def test_every_channel_gets_the_message_one_json_line_each(self):
        self.feishu_on()
        self.slack_on()
        self.telegram_on()
        self.webhook_on()
        if websockets:
            self.bot_on()
        code, lines, _ = self.run_main("hello")
        want = ["feishu", "slack", "telegram", "wecom_webhook"] + (["wecom_bot"] if websockets else [])
        self.assertEqual((code, [l["channel"] for l in lines]), (0, want))
        self.assertTrue(all(l["ok"] and l["messages"] == 1 for l in lines), lines)

    def test_one_failing_channel_exits_1_and_does_not_block_the_rest(self):
        self.feishu_on()
        self.telegram_on()
        os.environ["FEISHU_APP_SECRET"] = "wrong-secret"
        code, lines, _ = self.run_main("hello")
        self.assertEqual(code, 1)
        self.assertEqual([(l["channel"], l["ok"]) for l in lines], [("feishu", False), ("telegram", True)])
        self.assertEqual(len(Fake.named("sendMessage")), 1)

    def test_unreachable_channel_is_an_error_line_not_a_crash(self):
        self.slack_on()
        os.environ["SLACK_API_BASE"] = "http://127.0.0.1:9"
        code, lines, raw = self.run_main("x")
        self.assertEqual((code, lines[0]["ok"]), (1, False))
        self.assertIn("URLError", lines[0]["error"])
        self.assertNotIn("xoxb-secret", raw)

    def test_dry_run_sends_nothing_and_shows_the_plan(self):
        self.feishu_on()
        self.slack_on()
        self.bot_on()
        mp3 = self.file()
        code, lines, _ = self.run_main(f"hello\nMEDIA:{mp3}\nMEDIA:/etc/hostname", ["--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(Fake.calls, [])
        self.assertEqual(FakeBot.frames, [])
        by = {l["channel"]: l for l in lines}
        self.assertEqual(by["feishu"]["chunks"], ["hello\nMEDIA:/etc/hostname"])  # outside the workspace -> stays text
        self.assertEqual(by["feishu"]["attachments"], [mp3])
        self.assertEqual(by["slack"]["attachments"], [mp3])
        self.assertEqual(by["wecom_bot"]["attachments"], [mp3])
        self.assertTrue(all(l["dry_run"] and l["ok"] for l in lines))

    def test_dry_run_still_exits_2_without_channels(self):
        self.assertEqual(self.run_main("x", ["--dry-run"])[0], 2)

    def test_text_file_instead_of_stdin(self):
        self.telegram_on()
        path = self.file("out.txt", "来自文件".encode())
        code, _, _ = self.run_main("ignored stdin", ["--text-file", path])
        self.assertEqual(code, 0)
        self.assertEqual(jbody(Fake.named("sendMessage")[0])["text"], "来自文件")

    def test_rejected_media_line_is_delivered_as_text(self):
        self.telegram_on()
        self.run_main("report\nMEDIA:/etc/hostname")
        self.assertEqual(jbody(Fake.named("sendMessage")[0])["text"], "report\nMEDIA:/etc/hostname")
        self.assertEqual(Fake.named("sendDocument") + Fake.named("sendAudio"), [])

    def test_attachment_only_run_sends_no_empty_text(self):
        self.telegram_on()
        code, lines, _ = self.run_main(f"MEDIA:{self.file()}")
        self.assertEqual((code, lines[0]["messages"], lines[0]["attachments"]), (0, 0, 1))
        self.assertEqual(Fake.named("sendMessage"), [])

    def test_empty_message_sends_nothing_and_succeeds(self):
        self.telegram_on()
        code, lines, _ = self.run_main("  \n")
        self.assertEqual((code, lines[0]["skipped"]), (0, "empty message"))
        self.assertEqual(Fake.calls, [])

    def test_invalid_utf8_stdin_does_not_crash(self):
        self.telegram_on()
        with mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(b"ok \xff\xfe bytes"))), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(notify.main([]), 0)
        self.assertTrue(jbody(Fake.named("sendMessage")[0])["text"].startswith("ok "))

    def test_no_secret_in_output_for_any_failing_channel(self):
        self.feishu_on()
        self.slack_on()
        self.telegram_on()
        self.webhook_on()
        Fake.override.update({
            "messages": {"code": 1, "msg": "bad t-123 feishu-secret"},
            "chat.postMessage": {"ok": False, "error": "xoxb-secret"},
            "sendMessage": (400, {"ok": False, "error_code": 400, "description": "123456:tg-secret"}),
            "send": {"errcode": 1, "errmsg": "wecom-key"},
        })
        code, lines, raw = self.run_main("x")
        self.assertEqual((code, [l["ok"] for l in lines]), (1, [False] * 4))
        for s in SECRETS + ("t-123",):
            self.assertNotIn(s, raw)


class Process(Base):
    """The real command line: stdin, exit codes."""

    def run_cli(self, text, env, *argv):
        base_env = {k: v for k, v in os.environ.items() if k not in CHANNEL_ENVS}
        return subprocess.run([sys.executable, os.path.join(HERE, "..", "notify.py"), *argv],
                              input=text.encode(), capture_output=True, env={**base_env, **env}, timeout=60)

    def test_exit_2_when_nothing_is_configured(self):
        r = self.run_cli("hello", {})
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stdout)["error"], "no channel configured")

    def test_exit_0_and_exit_1(self):
        env = {"TELEGRAM_BOT_TOKEN": "123456:tg-secret", "TELEGRAM_CHAT_ID": "42", "TELEGRAM_API_BASE": self.base + "/tg"}
        r = self.run_cli("hello 世界", env)
        self.assertEqual((r.returncode, json.loads(r.stdout)["ok"]), (0, True))
        self.assertEqual(jbody(Fake.named("sendMessage")[0])["text"], "hello 世界")
        r = self.run_cli("hello", {**env, "TELEGRAM_BOT_TOKEN": "123456:nope"})
        self.assertEqual((r.returncode, json.loads(r.stdout)["ok"]), (1, False))
        self.assertNotIn(b"nope", r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
