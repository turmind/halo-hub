#!/usr/bin/env python3
"""
IM push for the agentcore-deploy runtime: sends a finished run's final reply
to every chat channel whose environment variables are set.

Halo's `halo agentcore` runs this as HALO_AGENTCORE_NOTIFY with the reply on
stdin (or pass --text-file F). Lines `MEDIA:<abs path>` are attachments: the
path must be an absolute regular file under $HALO_WORKSPACE (when set),
otherwise the line is left in the text. Everything else is the message.

Channels (ON when all required vars are set; `<CH>_CHANNEL=OFF` forces it
off; for Slack that is `SLACK_CHANNEL=OFF`, the target var itself):

  Feishu / Lark  FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_RECEIVE_ID
                 FEISHU_RECEIVE_ID_TYPE (chat_id | open_id | user_id | union_id | email,
                 default chat_id), FEISHU_API_BASE (https://open.feishu.cn;
                 Lark intl: https://open.larksuite.com), FEISHU_CHANNEL=OFF
  Slack          SLACK_BOT_TOKEN, SLACK_CHANNEL (channel id, or a user id U... for a DM)
                 SLACK_API_BASE (https://slack.com/api)
  Telegram       TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (numeric)
                 TELEGRAM_API_BASE (https://api.telegram.org), TELEGRAM_CHANNEL=OFF
  WeCom webhook WECOM_WEBHOOK_KEY (the key, or the whole webhook URL); group bot,
                 WECOM_API_BASE (https://qyapi.weixin.qq.com)
  WeCom bot      WECOM_BOT_ID, WECOM_BOT_SECRET, WECOM_CHAT_ID,
                 WECOM_CHAT_TYPE (1 single (default) | 2 group | 0 let WeCom decide),
                 WECOM_WS_URL (wss://openws.work.weixin.qq.com)
                 WECOM_CHANNEL=OFF turns off both WeCom channels.

WeCom 智能机器人 (wecom_bot): WeCom keeps ONE live connection per bot and a new
subscribe kicks the old one. Use a bot dedicated to this job -- never one a
Halo server (or anything else) is connected to, or you knock it offline. The
receiver must have messaged the bot first. Attachments go over the same
connection: temp-media upload (aibot_upload_media_init / _chunk / _finish,
512 KB chunks, file 5 B..20 MB) then an aibot_send_msg `file` message. voice
takes amr only, so mp3 is always sent as a file. If an upload fails, a visible
"[attachment not sent: <name> -- <why>]" line goes into the chat instead.

Output: one JSON line per channel {"channel", "ok", "messages", "attachments",
["error"]}; exit 0 all ok, 1 any failed, 2 no channel configured. Secrets are
never printed (scrubbed from every error). --dry-run sends nothing and prints
what each channel would get.

Standard library only, except wecom_bot which needs `websockets` (Debian:
python3-websockets, which is 10.4 on bookworm -- hence the asyncio API, not
websockets.sync). It is imported lazily: if missing, only that channel fails.
"""

import argparse
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, NamedTuple

HTTP_TIMEOUT = 30
WS_TIMEOUT = 10
CHUNK_DELAY = 1.0  # pause between messages (Slack ~1/s per channel, WeCom bot 30/min)
WECOM_WEBHOOK_DELAY = 3.0  # WeCom webhook allows 20 messages/min
PREFIX_ROOM = 16  # room reserved in a chunk for the "(i/n)\n" prefix

FEISHU_TEXT_LIMIT = 4500  # chars
SLACK_TEXT_LIMIT = 4000  # chars, before & < > escaping (Slack advises <= 4000)
TELEGRAM_TEXT_LIMIT = 4000  # chars, the API caps at 4096
WECOM_WEBHOOK_LIMIT = 4096  # utf-8 bytes, markdown_v2 content
WECOM_BOT_LIMIT = 20480  # utf-8 bytes, markdown content
WECOM_UPLOAD_CHUNK = 512 * 1024  # bytes before base64; the API allows at most 100 chunks
WECOM_FILE_MIN, WECOM_FILE_MAX = 5, 20 * 1024 * 1024  # bytes, `file` type

SECRET_VARS = ("FEISHU_APP_SECRET", "SLACK_BOT_TOKEN", "TELEGRAM_BOT_TOKEN",
               "WECOM_WEBHOOK_KEY", "WECOM_BOT_SECRET", "WECOM_BOT_ID")
_runtime_secrets = []  # tokens obtained while running (Feishu tenant token, Slack upload URL)


class NotifyError(Exception):
    """An API-level failure whose message is already fit for the output line."""


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _off(name: str) -> bool:
    return _env(name).upper() == "OFF"


def _webhook_key() -> str:
    v = _env("WECOM_WEBHOOK_KEY")
    if v.startswith("http"):
        return urllib.parse.parse_qs(urllib.parse.urlparse(v).query).get("key", [""])[0]
    return v


def _scrub(msg: str) -> str:
    secret_values = [_env(n) for n in SECRET_VARS] + [_webhook_key()] + _runtime_secrets
    for s in sorted({v for v in secret_values if v}, key=len, reverse=True):
        msg = msg.replace(s, "***").replace(urllib.parse.quote(s), "***")
    return msg


def _describe(e: Exception) -> str:
    return str(e) if isinstance(e, NotifyError) else f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------- splitting


def _chars(s: str) -> int:
    return len(s)


def _bytes(s: str) -> int:
    return len(s.encode("utf-8"))


def split_text(text: str, limit: int, size: Callable[[str], int]) -> list:
    """
    Split text into pieces of at most `limit` (measured by `size`), breaking at
    line boundaries where possible and never inside a character.
    """
    chunks, cur, cur_n = [], [], 0

    def flush():
        nonlocal cur, cur_n
        if cur:
            chunks.append("".join(cur).rstrip("\n"))
        cur, cur_n = [], 0

    for line in text.splitlines(keepends=True):
        n = size(line)
        if n > limit:
            # One line longer than a whole message: cut it by characters.
            flush()
            piece, pn = [], 0
            for ch in line:
                cn = size(ch)
                if pn + cn > limit:
                    chunks.append("".join(piece))
                    piece, pn = [], 0
                piece.append(ch)
                pn += cn
            if piece:
                cur, cur_n = piece, pn
            continue
        if cur_n + n > limit:
            flush()
        cur.append(line)
        cur_n += n
    flush()
    return [c for c in chunks if c.strip()]


def chunk_message(text: str, limit: int, size: Callable[[str], int]) -> list:
    parts = split_text(text, limit - PREFIX_ROOM, size)
    if len(parts) > 1:
        parts = [f"({i}/{len(parts)})\n{p}" for i, p in enumerate(parts, 1)]
    return parts


# -------------------------------------------------------------------- media

_MEDIA_LINE = re.compile(r"MEDIA:\s*(\S.*?)\s*")


def media_allowed(path: str) -> bool:
    """Absolute regular file, and under $HALO_WORKSPACE when that is set (symlinks resolved)."""
    if not os.path.isabs(path):
        return False
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        return False
    ws = _env("HALO_WORKSPACE")
    if not ws:
        return True
    root = os.path.realpath(ws)
    return os.path.commonpath([root, real]) == root


def extract_media(raw: str) -> tuple:
    """-> (text without the accepted MEDIA lines, [attachment paths]). Rejected MEDIA lines stay in the text."""
    kept, media = [], []
    for line in raw.replace("\r\n", "\n").split("\n"):
        m = _MEDIA_LINE.fullmatch(line)
        if m and media_allowed(m.group(1)):
            if m.group(1) not in media:
                media.append(m.group(1))
            continue
        kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip(), media


# --------------------------------------------------------------------- http


def _post(url: str, data: bytes, ctype: str, headers: dict = None) -> tuple:
    """-> (status, body text). HTTP error statuses are returned, not raised: APIs put the reason in the body."""
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _call(url: str, data: bytes, ctype: str, headers: dict = None) -> dict:
    status, text = _post(url, data, ctype, headers)
    try:
        out = json.loads(text)
    except ValueError:
        raise NotifyError(f"HTTP {status}: {text[:200]}")
    if not isinstance(out, dict):
        raise NotifyError(f"HTTP {status}: unexpected response {text[:200]}")
    return out


def _post_json(url: str, body: dict, headers: dict = None) -> dict:
    return _call(url, json.dumps(body, ensure_ascii=False).encode("utf-8"),
                 "application/json; charset=utf-8", headers)


def _post_multipart(url: str, fields: dict, file_field: str, path: str, headers: dict = None,
                    with_length: bool = False) -> dict:
    boundary = "----notify" + secrets.token_hex(12)
    name = os.path.basename(path).replace('"', "%22").replace("\r", "").replace("\n", "")
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        content = f.read()
    length = f"; filelength={len(content)}" if with_length else ""  # WeCom's upload doc shows it
    body = b"".join(
        [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8")
         for k, v in fields.items()]
        + [f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{name}"{length}\r\n'
           f"Content-Type: {ctype}\r\n\r\n".encode("utf-8"), content,
           f"\r\n--{boundary}--\r\n".encode("utf-8")])
    return _call(url, body, f"multipart/form-data; boundary={boundary}", headers)


def _send_files(res: dict, files: list, send_one: Callable[[str], None]) -> None:
    """Every attachment is tried; failures are raised together once all were attempted."""
    errors = []
    for p in files:
        try:
            send_one(p)
            res["attachments"] += 1
        except Exception as e:
            errors.append(f"{os.path.basename(p)}: {_describe(e)}")
    if errors:
        raise NotifyError("attachment failed: " + "; ".join(errors))


def _pause(i: int, delay: float = None) -> None:
    if i:
        time.sleep(CHUNK_DELAY if delay is None else delay)


# ------------------------------------------------------------------- feishu


def send_feishu(res: dict, chunks: list, files: list) -> None:
    base = (_env("FEISHU_API_BASE") or "https://open.feishu.cn").rstrip("/")
    receive_id = _env("FEISHU_RECEIVE_ID")
    id_type = _env("FEISHU_RECEIVE_ID_TYPE") or "chat_id"

    def check(r: dict, step: str) -> dict:
        if r.get("code") != 0:
            raise NotifyError(f"{step}: code {r.get('code')} {str(r.get('msg', ''))[:300]}")
        return r

    t = check(_post_json(f"{base}/open-apis/auth/v3/tenant_access_token/internal",
                         {"app_id": _env("FEISHU_APP_ID"), "app_secret": _env("FEISHU_APP_SECRET")}), "token")
    if not t.get("tenant_access_token"):
        raise NotifyError("token: no tenant_access_token in the response")
    _runtime_secrets.append(t["tenant_access_token"])
    auth = {"Authorization": "Bearer " + t["tenant_access_token"]}
    messages = f"{base}/open-apis/im/v1/messages?receive_id_type={urllib.parse.quote(id_type)}"

    def send(msg_type: str, content: dict) -> None:
        check(_post_json(messages, {"receive_id": receive_id, "msg_type": msg_type,
                                    "content": json.dumps(content, ensure_ascii=False)}, auth), "send")

    for i, part in enumerate(chunks):
        _pause(i)
        send("text", {"text": part})
        res["messages"] += 1

    def send_file(path: str) -> None:
        up = check(_post_multipart(f"{base}/open-apis/im/v1/files",
                                   {"file_type": "stream", "file_name": os.path.basename(path)},
                                   "file", path, auth), "upload")
        send("file", {"file_key": (up.get("data") or {}).get("file_key", "")})

    _send_files(res, files, send_file)


# -------------------------------------------------------------------- slack


def _slack_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def send_slack(res: dict, chunks: list, files: list) -> None:
    base = (_env("SLACK_API_BASE") or "https://slack.com/api").rstrip("/")
    target = _env("SLACK_CHANNEL")
    auth = {"Authorization": "Bearer " + _env("SLACK_BOT_TOKEN")}

    def check(r: dict, method: str) -> dict:
        if r.get("ok") is not True:
            needed = f" (needed scope: {r['needed']})" if r.get("needed") else ""
            raise NotifyError(f"{method}: {r.get('error', 'unknown')}{needed}")
        return r

    for i, part in enumerate(chunks):
        _pause(i)
        check(_post_json(f"{base}/chat.postMessage", {"channel": target, "text": _slack_escape(part)}, auth),
              "chat.postMessage")
        res["messages"] += 1

    if not files:
        return
    channel_id = target
    if re.fullmatch(r"[UW][A-Z0-9]+", target):  # completeUploadExternal needs a channel id, not a user id
        channel_id = check(_post_json(f"{base}/conversations.open", {"users": target}, auth),
                           "conversations.open").get("channel", {}).get("id", "")

    def send_file(path: str) -> None:
        with open(path, "rb") as f:
            content = f.read()
        name = os.path.basename(path)
        step1 = check(_call(f"{base}/files.getUploadURLExternal",
                            urllib.parse.urlencode({"filename": name, "length": len(content)}).encode(),
                            "application/x-www-form-urlencoded", auth), "files.getUploadURLExternal")
        _runtime_secrets.append(step1["upload_url"])
        status, text = _post(step1["upload_url"], content, "application/octet-stream")
        if status != 200:
            raise NotifyError(f"upload_url: HTTP {status} {text[:200]}")
        check(_post_json(f"{base}/files.completeUploadExternal",
                         {"files": [{"id": step1["file_id"], "title": name}], "channel_id": channel_id}, auth),
              "files.completeUploadExternal")

    _send_files(res, files, send_file)


# ----------------------------------------------------------------- telegram


def send_telegram(res: dict, chunks: list, files: list) -> None:
    base = (_env("TELEGRAM_API_BASE") or "https://api.telegram.org").rstrip("/")
    chat_id = _env("TELEGRAM_CHAT_ID")
    api = f"{base}/bot{_env('TELEGRAM_BOT_TOKEN')}"

    def check(r: dict, method: str) -> dict:
        if r.get("ok") is not True:
            code, desc = r.get("error_code"), r.get("description", "unknown")
            if code == 403:
                raise NotifyError(f"{method}: 403 {desc} -- the chat must have messaged the bot at least once "
                                  "(open the bot and press Start), must not have blocked it, and a group must "
                                  "contain the bot")
            raise NotifyError(f"{method}: {code} {desc}")
        return r

    for i, part in enumerate(chunks):
        _pause(i)
        check(_post_json(f"{api}/sendMessage", {"chat_id": chat_id, "text": part}), "sendMessage")
        res["messages"] += 1

    def send_file(path: str) -> None:
        if os.path.splitext(path)[1].lower() in (".mp3", ".m4a"):  # the formats sendAudio accepts
            method, field = "sendAudio", "audio"
        else:
            method, field = "sendDocument", "document"
        check(_post_multipart(f"{api}/{method}", {"chat_id": chat_id}, field, path), method)

    _send_files(res, files, send_file)


# ------------------------------------------------------------ wecom webhook


def send_wecom_webhook(res: dict, chunks: list, files: list) -> None:
    base = (_env("WECOM_API_BASE") or "https://qyapi.weixin.qq.com").rstrip("/")
    key = urllib.parse.quote(_webhook_key())

    def check(r: dict, step: str) -> dict:
        if r.get("errcode") != 0:
            raise NotifyError(f"{step}: errcode {r.get('errcode')} {str(r.get('errmsg', ''))[:300]}")
        return r

    send_url = f"{base}/cgi-bin/webhook/send?key={key}"
    for i, part in enumerate(chunks):
        _pause(i, WECOM_WEBHOOK_DELAY)
        check(_post_json(send_url, {"msgtype": "markdown_v2", "markdown_v2": {"content": part}}), "send")
        res["messages"] += 1

    def send_file(path: str) -> None:
        up = check(_post_multipart(f"{base}/cgi-bin/webhook/upload_media?key={key}&type=file", {}, "media", path,
                               with_length=True),
                   "upload_media")
        check(_post_json(send_url, {"msgtype": "file", "file": {"media_id": up.get("media_id", "")}}), "send")

    _send_files(res, files, send_file)


# ---------------------------------------------------------------- wecom bot


def _req_id(cmd: str) -> str:
    # Same shape as the official SDK: {cmd}_{ms timestamp}_{random}
    return f"{cmd}_{int(time.time() * 1000)}_{secrets.token_hex(4)}"


async def _ws_call(ws, cmd: str, body: dict) -> dict:
    """
    Send one request frame and wait for its ack. Acks carry no cmd, only the
    same headers.req_id, so anything else that arrives meanwhile (message or
    event callbacks) is skipped; a disconnected_event means another
    connection took the bot over.
    """
    rid = _req_id(cmd)
    await ws.send(json.dumps({"cmd": cmd, "headers": {"req_id": rid}, "body": body}, ensure_ascii=False))
    deadline = time.monotonic() + WS_TIMEOUT
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"no ack for {cmd} within {WS_TIMEOUT:g}s")
        try:
            raw = await asyncio.wait_for(ws.recv(), left)
        except asyncio.TimeoutError:
            raise TimeoutError(f"no ack for {cmd} within {WS_TIMEOUT:g}s")
        try:
            m = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(m, dict):
            continue
        if (m.get("headers") or {}).get("req_id") == rid:
            return m
        if m.get("cmd") == "aibot_event_callback" and "disconnected_event" in json.dumps(m):
            raise ConnectionError("disconnected_event: another connection took over this bot")


def _wecom_ok(r: dict, step: str) -> dict:
    if r.get("errcode") != 0:
        raise NotifyError(f"{step}: errcode {r.get('errcode')} {str(r.get('errmsg', ''))[:300]}")
    return r


async def _wecom_upload(ws, path: str) -> str:
    """Temp-media upload over the live connection (init -> chunks -> finish) -> media_id."""
    size = os.path.getsize(path)
    if not WECOM_FILE_MIN <= size <= WECOM_FILE_MAX:
        raise NotifyError(f"file is {size} bytes; WeCom takes {WECOM_FILE_MIN}..{WECOM_FILE_MAX}")
    with open(path, "rb") as f:
        content = f.read()
    total = -(-size // WECOM_UPLOAD_CHUNK)
    r = _wecom_ok(await _ws_call(ws, "aibot_upload_media_init", {
        "type": "file", "filename": os.path.basename(path), "total_size": size, "total_chunks": total,
        "md5": hashlib.md5(content).hexdigest()}), "upload init")
    upload_id = (r.get("body") or {}).get("upload_id")
    if not upload_id:
        raise NotifyError("upload init: no upload_id in the response")
    for i in range(total):  # one at a time: WeCom answers "system error" to many parallel chunks
        piece = content[i * WECOM_UPLOAD_CHUNK:(i + 1) * WECOM_UPLOAD_CHUNK]
        _wecom_ok(await _ws_call(ws, "aibot_upload_media_chunk", {
            "upload_id": upload_id, "chunk_index": i, "base64_data": base64.b64encode(piece).decode()}),
            f"upload chunk {i + 1}/{total}")
    r = _wecom_ok(await _ws_call(ws, "aibot_upload_media_finish", {"upload_id": upload_id}), "upload finish")
    media_id = (r.get("body") or {}).get("media_id")
    if not media_id:
        raise NotifyError("upload finish: no media_id in the response")
    return media_id


async def _wecom_bot_session(websockets, res: dict, chunks: list, files: list, chat_id: str, chat_type: int) -> None:
    async def send(msgtype: str, content: dict) -> None:
        _wecom_ok(await _ws_call(ws, "aibot_send_msg", {"chatid": chat_id, "chat_type": chat_type,
                                                        "msgtype": msgtype, msgtype: content}), "send")

    async with websockets.connect(_env("WECOM_WS_URL") or "wss://openws.work.weixin.qq.com",
                                  open_timeout=WS_TIMEOUT, close_timeout=5, ping_interval=None) as ws:
        _wecom_ok(await _ws_call(ws, "aibot_subscribe",
                                 {"bot_id": _env("WECOM_BOT_ID"), "secret": _env("WECOM_BOT_SECRET")}), "subscribe")
        for i, part in enumerate(chunks):
            if i:
                await asyncio.sleep(CHUNK_DELAY)
            await send("markdown", {"content": part})
            res["messages"] += 1
        failed = []
        for path in files:
            try:
                await send("file", {"media_id": await _wecom_upload(ws, path)})
                res["attachments"] += 1
            except Exception as e:  # report it in the chat, keep going with the rest
                failed.append(f"{os.path.basename(path)}: {_describe(e)}")
        if failed:
            notes = "\n".join(f"[attachment not sent: {f.replace(': ', ' -- ', 1)}]" for f in failed)
            try:
                await send("markdown", {"content": _scrub(notes)})
                res["messages"] += 1
            except Exception:
                pass  # the channel error below still lists every failure
            raise NotifyError("attachment failed: " + "; ".join(failed))


def send_wecom_bot(res: dict, chunks: list, files: list) -> None:
    try:
        chat_type = int(_env("WECOM_CHAT_TYPE") or "1")
    except ValueError:
        chat_type = -1
    if chat_type not in (0, 1, 2):
        raise NotifyError("WECOM_CHAT_TYPE must be 0, 1 or 2")
    try:
        import websockets
    except ImportError:
        raise NotifyError("python module 'websockets' is not installed (Debian: apt install python3-websockets)")
    asyncio.run(_wecom_bot_session(websockets, res, chunks, files, _env("WECOM_CHAT_ID"), chat_type))


# ----------------------------------------------------------------- channels


class Channel(NamedTuple):
    name: str
    required: tuple  # env vars that must all be set
    off_var: str  # `<off_var>=OFF` disables the channel
    limit: int
    size: Callable[[str], int]
    send: Callable[[dict, list, list], None]


CHANNELS = (
    Channel("feishu", ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_RECEIVE_ID"), "FEISHU_CHANNEL",
            FEISHU_TEXT_LIMIT, _chars, send_feishu),
    Channel("slack", ("SLACK_BOT_TOKEN", "SLACK_CHANNEL"), "SLACK_CHANNEL",
            SLACK_TEXT_LIMIT, _chars, send_slack),
    Channel("telegram", ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"), "TELEGRAM_CHANNEL",
            TELEGRAM_TEXT_LIMIT, _chars, send_telegram),
    Channel("wecom_webhook", ("WECOM_WEBHOOK_KEY",), "WECOM_CHANNEL",
            WECOM_WEBHOOK_LIMIT, _bytes, send_wecom_webhook),
    Channel("wecom_bot", ("WECOM_BOT_ID", "WECOM_BOT_SECRET", "WECOM_CHAT_ID"), "WECOM_CHANNEL",
            WECOM_BOT_LIMIT, _bytes, send_wecom_bot),
)


def enabled_channels() -> list:
    out = []
    for ch in CHANNELS:
        if _off(ch.off_var):
            continue
        missing = [v for v in ch.required if not _env(v)]
        if not missing:
            out.append(ch)
        elif len(missing) < len(ch.required):
            log(f"{ch.name}: {', '.join(missing)} not set, channel skipped")
    return out


def log(msg: str) -> None:
    print(f"[Notify] {_scrub(msg)}", file=sys.stderr)


def emit(obj: dict) -> None:
    print(_scrub(json.dumps(obj)))  # ASCII-only: safe on any stdout encoding


def run_channel(ch: Channel, chunks: list, files: list) -> dict:
    res = {"channel": ch.name, "ok": False, "messages": 0, "attachments": 0}
    try:
        ch.send(res, chunks, files)
        res["ok"] = True
    except Exception as e:  # one broken channel must not stop the others
        res["error"] = _scrub(_describe(e))
    return res


# ---------------------------------------------------------------------- CLI


def main(argv: list) -> int:
    p = argparse.ArgumentParser(description="Push a run's final reply to the env-configured IM channels.")
    p.add_argument("--text-file", help="read the message from this file; default: stdin")
    p.add_argument("--dry-run", action="store_true", help="print what would be sent, send nothing")
    a = p.parse_args(argv)

    if a.text_file:
        with open(a.text_file, "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    else:
        raw = sys.stdin.buffer.read().decode("utf-8", "replace")

    channels = enabled_channels()
    if not channels:
        emit({"channel": None, "ok": False, "error": "no channel configured"})
        return 2

    text, media = extract_media(raw)
    failed = False
    for ch in channels:
        chunks, files = chunk_message(text, ch.limit, ch.size), media
        if not chunks and not files:
            emit({"channel": ch.name, "ok": True, "messages": 0, "attachments": 0, "skipped": "empty message"})
            continue
        if a.dry_run:
            emit({"channel": ch.name, "ok": True, "dry_run": True, "chunks": chunks, "attachments": files})
            continue
        res = run_channel(ch, chunks, files)
        emit(res)
        log(f"{ch.name} {'ok' if res['ok'] else 'failed: ' + res['error']}")
        failed = failed or not res["ok"]
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
