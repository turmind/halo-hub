#!/usr/bin/env python3
"""Dependency scan before moving a Halo cron job to Amazon Bedrock AgentCore Runtime.

  python3 scan.py <workspace> [--cron-job ID] [--agent ID] [--json]

Read-only. Looks at the cron job (~/.halo/global/cron.db), the agent's
agent.yaml (workspace .halo/agents/<id>/, else ~/.halo/global/agents/<id>/) and
its model provider, the enabled skills, and the scripts the prompt / agent /
skills call. Never opens ~/.halo/secrets.

Reports:
  blockers     what can't work in the runtime (localhost services, GPU, binaries
               missing from the image, WeChat / WeCom smart-bot targets,
               API-key providers, skills the image won't have)
  paths        absolute host paths: the ones sync rewrites to /workspace, the
               ones it doesn't
  iam_actions  extra actions for the runtime role (boto3 clients, `aws <svc> <op>`)
  size         workspace bytes sync copies
  channels     which notify env vars replace the local cron targets

--json prints one JSON object; deploy.py imports this module for the same data.
Python: stdlib + boto3 (botocore maps boto3 method names to IAM actions).
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

GLOBAL = Path.home() / ".halo" / "global"
CRON_DB = GLOBAL / "cron.db"
CONTAINER_WS = "/workspace"  # the job's workspace inside the runtime worker (CONTRACT §1b)

# What sync copies (CONTRACT §1f). The agent config always goes; `data` picks the rest:
#   none (default) = config + files the job prompt references · all = whole workspace · [paths] = config + those
#   (+ `session:<id>` = that Halo session's history, for a scheduled job's fixed session).
CONFIG_PATHS = (".halo/agents", ".halo/skills", ".halo/prompts", ".halo/INSTRUCTIONS.md", ".halo/INDEX.md",
                ".halo/USER.md", ".halo/agent-card.json")
# Never copied, whatever `data` says: Halo state + secrets. Sessions come along only via `session:<id>`.
EXCLUDE_DIRS = (".halo/sessions", ".halo/tmp", ".halo/logs", ".halo/secrets")
EXCLUDE_NAMES = ("node_modules", "__pycache__", ".ssh", ".aws", ".gnupg")  # dirs, at any depth
EXCLUDE_FILES = (".halo/settings.yaml",)  # workspace settings carry provider api keys
EXCLUDE_FILE_RE = re.compile(r"\.db(-wal|-shm|-journal)?$|^(runtime|server)\.lock$|^agentcore\.lease")
SECRET_FILE_RE = re.compile(r"^\.env(\..+)?$|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|"
                            r"^\.(git-credentials|netrc|npmrc|pypirc)$|^credentials(\.json)?$")

# Binaries in the image (node:22-slim arm64 `ls` of /bin /usr/bin /usr/sbin /sbin
# /usr/local/bin, 2026-10) + what the Dockerfile installs. Admin-only tools trimmed.
IMAGE_BINARIES = set("""
[ arch awk b2sum base32 base64 basename basenc bash cat chcon chgrp chmod chown chroot cksum cmp comm cp
csplit cut dash date dd df diff diff3 dir dircolors dirname du echo egrep env expand expr factor false fgrep
find findmnt flock fmt fold getconf getent getopt grep groups gunzip gzexe gzip head hostid hostname iconv id
install ionice join link ln locale logger logname ls lsblk lscpu md5sum mkdir mkfifo mknod mktemp more mount
mountpoint mv namei nawk nice nl node nodejs nohup npm npx nproc nsenter numfmt od pager paste pathchk perl
pidof pr printenv printf prlimit ptx pwd readlink realpath renice rev rgrep rm rmdir run-parts runuser script
sdiff sed seq setpriv setsid sh sha1sum sha224sum sha256sum sha384sum sha512sum shred shuf sleep sort split
stat stdbuf stty su sum sync tac tail tar taskset tee tempfile test timeout touch tr true truncate tsort tty
tzselect umount uname uncompress unexpand uniq unlink unshare users vdir wc whereis which who whoami xargs
yarn yes zcat zcmp zdiff zegrep zfgrep zforce zgrep zless zmore znew
python3 python3.11 git bwrap halo
""".split())
SHELL_WORDS = set("""
cd export set unset source . alias read exit return local eval exec trap wait ulimit umask type command hash
shift if then else elif fi for while until do done case esac function in time ! { } [[ ]]
""".split())
# Debian package for a missing binary (deploy.py image --apt <pkg>); None = no
# package makes sense in a runtime microVM.
APT = {
    "file": "file", "curl": "curl", "wget": "wget", "jq": "jq", "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg",
    "sqlite3": "sqlite3", "zip": "zip", "unzip": "unzip", "rsync": "rsync", "pandoc": "pandoc",
    "convert": "imagemagick", "magick": "imagemagick", "sox": "sox", "ps": "procps", "pgrep": "procps",
    "pkill": "procps", "top": "procps", "free": "procps", "less": "less", "ssh": "openssh-client",
    "scp": "openssh-client", "dig": "dnsutils", "ping": "iputils-ping", "ip": "iproute2", "nc": "netcat-openbsd",
    "xz": "xz-utils", "bc": "bc", "tree": "tree", "make": "make", "gcc": "gcc", "g++": "g++",
    "pip": "python3-pip", "pip3": "python3-pip", "openssl": "openssl", "envsubst": "gettext-base",
    "systemctl": None, "journalctl": None, "service": None, "docker": None, "nvidia-smi": None,
    "aws": None,  # use boto3 in a script instead (python3-boto3 is in the image)
}
# Python modules in the image besides the stdlib (Debian python3-boto3 + deps, python3-websockets).
IMAGE_PY = {"boto3", "botocore", "s3transfer", "jmespath", "dateutil", "urllib3", "six", "websockets"}
PY_APT = {"pptx": "python3-pptx", "PIL": "python3-pil", "yaml": "python3-yaml", "cv2": "python3-opencv",
          "bs4": "python3-bs4", "docx": "python3-docx", "sklearn": "python3-sklearn"}  # import name → Debian package
APT.update({"pdftoppm": "poppler-utils", "pdftotext": "poppler-utils", "pdffonts": "poppler-utils",
            "libreoffice": "libreoffice-impress", "tesseract": "tesseract-ocr", "xvfb-run": "xvfb", "patch": "patch"})
BUNDLED_FALLBACK = {"agent", "aws-knowledge", "cron", "extension", "halo", "self", "send-file", "skill",
                    "web-search", "workspace"}
BEDROCK_RUNTIMES = {"bedrock-invoke": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                    "bedrock-mantle": ["bedrock-mantle:CreateInference"]}

# Local cron target → notify.py env vars (CONTRACT §2). ok False = blocker.
CHANNELS = {
    "feishu": {"ok": True, "vars": ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_RECEIVE_ID"],
               "chat_var": "FEISHU_RECEIVE_ID",
               "note": "receiver must be in the app's availability scope; Lark intl: FEISHU_API_BASE=https://open.larksuite.com"},
    "slack": {"ok": True, "vars": ["SLACK_BOT_TOKEN", "SLACK_CHANNEL"], "chat_var": "SLACK_CHANNEL",
              "note": "bot needs chat:write (+ files:write for attachments, im:write for a DM to a U… id)"},
    "telegram": {"ok": True, "vars": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], "chat_var": "TELEGRAM_CHAT_ID",
                 "note": "works once the user has messaged the bot one time"},
    "wecom": {"ok": False, "vars": ["WECOM_WEBHOOK_KEY"],
              "note": "this target is the server's WeCom 智能机器人 account: one long connection per bot, which the "
                      "local server holds — use a WeCom group-bot webhook (WECOM_WEBHOOK_KEY, group only), a "
                      "dedicated 智能机器人 (WECOM_BOT_ID / WECOM_BOT_SECRET / WECOM_CHAT_ID, the user must have "
                      "messaged it first) or another channel"},
    "wechat": {"ok": False, "vars": [],
               "note": "WeChat can't push from AgentCore — use Feishu / Slack / Telegram / WeCom group webhook"},
}

SID_PAT = r"[A-Za-z0-9][A-Za-z0-9_-]{32,255}"  # runtime session id = per-session dir name (CONTRACT §1b)
LOCALHOST_RE = re.compile(r"(?:https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|"
                          r"\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5})")
GPU_RE = re.compile(r"nvidia-smi|torch\.cuda|CUDA_VISIBLE_DEVICES|[\"']cuda(?::\d)?[\"']|device\s*=\s*[\"']?cuda")
HOST_PATH_RE = re.compile(r"(?<![\w.:/-])(?:~/|/(?:home|Users|root|mnt|srv|data|opt|var)/)[^\s'\"`)\]>，。、；）]*")
SCRIPT_RE = re.compile(r"(?<![\w/.~-])((?:~/|\.{1,2}/|/)?[\w.-]+(?:/[\w.-]+)*\.(?:py|sh|bash|js|mjs|cjs))(?![\w])")
FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
LANG_FENCE_RE = re.compile(r"```([^\n]*)\n(.*?)```", re.S)
INLINE_RE = re.compile(r"`([^`\n]+)`")


# ── workspace walk (shared with deploy.py) ───────────────────────────────

def excluded(rel, is_dir, node_modules=False):
    """Why `rel` is never copied (None = it may be)."""
    name = os.path.basename(rel)
    if is_dir:
        if rel in EXCLUDE_DIRS:
            return "halo state" if rel != ".halo/secrets" else "secrets"
        if name in EXCLUDE_NAMES and not (node_modules and name == "node_modules"):
            return "secrets" if name in (".ssh", ".aws", ".gnupg") else "build output"
        return None
    if rel in EXCLUDE_FILES or SECRET_FILE_RE.search(name):
        return "secrets"
    if EXCLUDE_FILE_RE.search(name):
        return "halo state"
    return None


def walk(ws, roots=None, node_modules=False, skip=(), dropped=None):
    """(rel, Path) for every file / symlink under `roots` (rel paths; None = the whole workspace), minus the
    always-excluded set and `skip` (rel dirs). dropped: dict that collects {rel: why} for excluded entries."""
    ws = Path(ws)
    for top in ([""] if roots is None else roots):
        p = ws / top
        if top and (p.is_symlink() or p.is_file()):
            why = excluded(top, False, node_modules)
            if why:
                dropped is not None and dropped.setdefault(top, why)
            elif not is_sqlite(p):
                yield top, p
            continue
        if not p.is_dir() or (top and (excluded(top, True, node_modules) or top in skip)):
            continue
        for root, dirs, files in os.walk(p):
            rel_root = os.path.relpath(root, ws)
            rel_root = "" if rel_root == "." else rel_root
            keep = []
            for d in dirs:
                rel = os.path.join(rel_root, d)
                why = excluded(rel, True, node_modules) or ("disabled" if rel in skip else None)
                if why:
                    dropped is not None and dropped.setdefault(rel + "/", why)
                elif os.path.islink(os.path.join(root, d)):
                    yield rel, Path(root) / d  # symlinked dir: copied as a link, not descended
                else:
                    keep.append(d)
            dirs[:] = keep
            for f in files:
                rel = os.path.join(rel_root, f)
                why = excluded(rel, False, node_modules)
                if not why and is_sqlite(Path(root) / f):
                    why = "halo state"  # any sqlite file, whatever its name
                if why:
                    dropped is not None and dropped.setdefault(rel, why)
                else:
                    yield rel, Path(root) / f


def parse_data(data):
    """config `data` → ('none'|'all'|'list', [paths], [session ids]); raises ValueError."""
    if data in (None, "", "none"):
        return "none", [], []
    if data == "all":
        return "all", [], []
    if not isinstance(data, list):
        raise ValueError(f"data must be none, all or a list of paths, not {data!r}")
    paths, sessions = [], []
    for x in data:
        x = str(x).strip()
        if x.startswith("session:"):
            sid = x[len("session:"):]
            if not re.fullmatch(r"[A-Za-z0-9_:-]{1,200}", sid):
                raise ValueError(f"data entry {x!r}: not a root session id")
            sessions.append(sid)
            continue
        x = x.rstrip("/")
        if not x or x.startswith("/") or ".." in Path(x).parts:
            raise ValueError(f"data entry {x!r}: needs a path relative to the workspace, without ..")
        paths.append(x)
    return "list", paths, sessions


def copy_set(ws, data="none", refs=(), node_modules=False, skip=()):
    """What sync copies: (files [(rel, Path)], sessions [ids], dropped {rel: why}, missing [paths])."""
    mode, paths, sessions = parse_data(data)
    dropped = {}
    if mode == "all":
        roots = None
    else:
        roots = list(dict.fromkeys(list(CONFIG_PATHS) + list(refs) + paths))
    missing = [x for x in paths if not (Path(ws) / x).exists()]
    files = list(walk(ws, roots, node_modules, skip, dropped))
    return files, sessions, dropped, missing


def top_level_sizes(ws, node_modules=False):
    """Every top-level entry the user could carry along (always-excluded ones left out): [{path, bytes, files}]."""
    out = {}
    for rel, p in walk(ws, None, node_modules):
        parts = rel.split(os.sep)
        head = os.sep.join(parts[:2]) if parts[0] == ".halo" and len(parts) > 1 else parts[0]
        try:
            s = p.lstat().st_size
        except OSError:
            continue
        e = out.setdefault(head, {"path": head, "bytes": 0, "files": 0})
        e["bytes"] += s
        e["files"] += 1
    return sorted(out.values(), key=lambda x: -x["bytes"])


def is_sqlite(p):
    try:
        with open(p, "rb") as f:
            return f.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def read_text(p, limit=2_000_000):
    try:
        if p.is_symlink() or p.stat().st_size > limit or is_sqlite(p):
            return None
        data = p.read_bytes()
    except OSError:
        return None
    if b"\x00" in data[:4096]:
        return None
    return data.decode("utf-8", "replace")


def rewrite_source_paths(text, src):
    """Absolute source-workspace paths → /workspace (the job prompt file only). Returns (text, count)."""
    pat = re.compile(re.escape(src.rstrip("/")) + r"(?![\w.-])")
    return pat.subn(CONTAINER_WS, text)


def files_mentioning(files, needle):
    """{rel: count} of the given (rel, Path) text files containing `needle`."""
    out = {}
    for rel, p in files:
        t = read_text(p)
        if t and needle in t:
            out[rel] = t.count(needle)
    return out


REF_RE = re.compile(r"(?<![\w./~-])((?:\.halo/|[\w-]+/)*[\w.-]+\.(?:md|txt|json|ya?ml|csv|py|sh|js|mjs))(?![\w/])")


def prompt_refs(ws, prompt):
    """Workspace files the job prompt names that exist now (`data: none` copies them). Paths under the
    always-excluded set (.halo/tmp, sessions…) are the run's own output or history — never refs."""
    out = []
    src = str(Path(ws)) + "/"
    for m in REF_RE.finditer(prompt.replace(src, "")):
        rel = m.group(1)
        p = Path(ws) / rel
        if p.is_file() and not any(rel == d or rel.startswith(d + "/") for d in EXCLUDE_DIRS) and rel not in out:
            out.append(rel)
    return out


def session_files(ws, sid):
    """(rel, Path) for one root session's history: .halo/sessions/<agent>/<sid>.{ui,raw}.jsonl + UI archive
    segments. Sub-sessions (`<sid>>…`) are named by their last segment and aren't followed."""
    out = []
    base = Path(ws) / ".halo" / "sessions"
    if base.is_dir():
        for p in sorted(base.glob(f"*/{sid}.*")):
            if p.is_file() and re.fullmatch(re.escape(sid) + r"\.(ui|raw)(\.arch\.[\w.]+)?\.jsonl(\.gz)?", p.name):
                out.append((str(p.relative_to(ws)), p))
    return out


# ── cron job / agent ──────────────────────────────────────────────────────

def load_cron_jobs(workspace=None, job_id=None):
    if not CRON_DB.is_file():
        return []
    con = sqlite3.connect(f"file:{CRON_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        if job_id:
            rows = con.execute("SELECT * FROM cron_jobs WHERE id = ?", (job_id,)).fetchall()
        else:
            rows = con.execute("SELECT * FROM cron_jobs WHERE workspace_path = ? ORDER BY created_at",
                               (str(workspace),)).fetchall()
    finally:
        con.close()
    jobs = []
    for r in rows:
        j = dict(r)
        try:
            j["targets"] = json.loads(j.get("targets") or "[]")
        except ValueError:
            j["targets"] = []
        jobs.append(j)
    return jobs


def cron_session(job):
    """The Halo chat session a run continues — cron/runner.ts effectiveSessionId; None = stateless."""
    if job.get("stateless"):
        return None
    return job.get("session_id") or (job["id"] if job["id"].startswith("cron-") else f"cron-{job['id']}")


def find_agent(ws, agent_id):
    for base, scope in ((Path(ws) / ".halo" / "agents", "workspace"), (GLOBAL / "agents", "global")):
        d = base / agent_id
        if (d / "agent.yaml").is_file():
            return d, scope
    return None, None


def _block(lines, i):
    """Indented lines under the top-level key at lines[i]."""
    out = []
    for line in lines[i + 1:]:
        if line.strip() and not line[:1].isspace():
            break
        out.append(line)
    return out


def _unquote(v):
    v = re.sub(r"\s+#.*$", "", v).strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"" else v


def parse_agent_yaml(text):
    """The agent.yaml subset the scan needs (no PyYAML): model.{provider,id,endpoint}, tools, skills, system_prompt."""
    out = {"model": {}, "tools": [], "skills": [], "team": [], "system_prompt": ""}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        key, rest = m.group(1), m.group(2).strip()
        block = _block(lines, i)
        if key == "model":
            indent = min((len(b) - len(b.lstrip()) for b in block if b.strip()), default=0)
            for b in block:
                mm = re.match(r"^(\s*)(provider|id|endpoint):\s*(.+)$", b)
                if mm and len(mm.group(1)) == indent:
                    out["model"][mm.group(2)] = _unquote(mm.group(3))
        elif key in ("tools", "skills", "team"):
            if rest.startswith("["):
                out[key] = [_unquote(x) for x in rest.strip("[]").split(",") if x.strip()]
            else:
                out[key] = [_unquote(b.strip()[1:]) for b in block if b.strip().startswith("-")]
        elif key == "system_prompt":
            if rest[:1] in (">", "|"):
                body = [b.strip() for b in block]
                out["system_prompt"] = ("\n" if rest[0] == "|" else " ").join(body).strip()
            else:
                out["system_prompt"] = _unquote(rest)
    return out


def provider_info(provider):
    """(runtime, [<<ENV>> secret defaults]) from the effective provider yaml."""
    for d in (GLOBAL / "models.d", GLOBAL / "models"):
        p = d / f"{provider}.yaml"
        if p.is_file():
            t = p.read_text(encoding="utf-8", errors="replace")
            rt = re.search(r"^runtime:\s*(\S+)", t, re.M)
            sec = re.search(r"^secrets:\n((?:[ \t#].*\n|\n)*)", t, re.M)
            envs = re.findall(r"default:\s*<<([A-Z_][A-Z0-9_]*)>>", sec.group(1)) if sec else []
            return (rt.group(1) if rt else None), envs
    return None, []


def bundled_skills():
    """Skill ids Halo seeds into ~/.halo/global/skills (= what the image has), and that templates dir."""
    halo = shutil.which("halo")
    if halo:
        d = Path(os.path.realpath(halo)).parent.parent / "templates" / "skills"
        if d.is_dir():
            return {p.name for p in d.iterdir() if p.is_dir()}, d
    return set(BUNDLED_FALLBACK), None


def db_snapshot(ws, dest_dir):
    """Copy the workspace halo.db (+ -wal / -shm) into dest_dir and return the copy's path, or None.
    Even a mode=ro connection may touch -shm; the copy keeps the source workspace untouched."""
    src = Path(ws) / ".halo" / "halo.db"
    if not src.is_file():
        return None
    for suf in ("", "-wal", "-shm"):
        if Path(str(src) + suf).is_file():
            shutil.copy2(str(src) + suf, Path(dest_dir) / ("halo.db" + suf))
    return Path(dest_dir) / "halo.db"


def disabled_items(ws):
    """{(item_type, item_id, scope)} from the workspace halo.db (agents / skills switched off here)."""
    with tempfile.TemporaryDirectory() as d:
        db = db_snapshot(ws, d)
        if not db:
            return set()
        try:
            con = sqlite3.connect(db)
            rows = con.execute("SELECT item_type, item_id, scope FROM disabled_items").fetchall()
            con.close()
            return {tuple(r) for r in rows}
        except sqlite3.Error:
            return set()


def disabled_skip(disabled):
    """Workspace dirs sync leaves out because they're disabled here (halo.db doesn't travel)."""
    return tuple(f".halo/{t}s/{i}" for t, i, s in sorted(disabled) if s == "workspace" and t in ("agent", "skill"))


def resolve_skill(ws, sid):
    for d, scope in ((Path(ws) / ".halo" / "skills" / sid, "workspace"), (GLOBAL / "skills" / sid, "global")):
        if (d / "SKILL.md").is_file():
            return d, scope
    for d in sorted((GLOBAL / "extensions").glob(f"*/skills/{sid}")):
        if (d / "SKILL.md").is_file():
            return d, "extension"
    return None, None


def same_tree(a, b):
    """Global skill unchanged from Halo's bundled template (so the image's copy is the same)?"""
    if b is None or not b.is_dir():
        return False
    fa = {p.relative_to(a): p for p in a.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
    fb = {p.relative_to(b): p for p in b.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
    return fa.keys() == fb.keys() and all(fa[k].read_bytes() == fb[k].read_bytes() for k in fa)


# ── text analysis ─────────────────────────────────────────────────────────

def code_parts(text):
    """Fenced blocks + inline code spans of markdown / prompt text."""
    parts = FENCE_RE.findall(text)
    parts += INLINE_RE.findall(FENCE_RE.sub("", text))
    return parts


HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\s*\1\s*(?:\n|$)", re.S)


def shell_parts(text):
    """The code that is shell: bash / sh / untagged fences + inline spans (python / js fences are not)."""
    fences = [body for lang, body in LANG_FENCE_RE.findall(text) if lang.strip().lower() in ("", "bash", "sh", "shell", "zsh", "console")]
    return fences + INLINE_RE.findall(FENCE_RE.sub("", text))


def commands_in(code):
    """First word of each simple command in a code snippet (heredoc bodies and quoted strings skipped)."""
    code = HEREDOC_RE.sub("\n", code)
    for line in code.splitlines():
        line = re.sub(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"", "''", line)
        line = re.sub(r"(^|\s)#.*$", "", line)
        for seg in re.split(r"&&|\|\||[;|]|\$\(|\(|\)", line):
            toks = seg.split()
            while toks and (re.match(r"^[A-Za-z_]\w*=", toks[0]) or toks[0] in ("sudo", "env", "nohup", "time", "exec", "command", "!")):
                toks.pop(0)
            if toks:
                yield toks[0]


def classify_command(tok):
    """'ok' | 'missing' | None (not a command / a script path)."""
    name = tok.rsplit("/", 1)[-1] if tok.startswith("/") else tok
    if "/" in name or not re.fullmatch(r"[A-Za-z][\w.+-]*", name) or re.search(r"\.(py|sh|js|mjs|md|txt|json|ya?ml)$", name):
        return None
    if name in SHELL_WORDS or name in IMAGE_BINARIES:
        return "ok"
    return "missing" if shutil.which(name) or name in APT else None


class Scan:
    def __init__(self, ws, cron_job=None, agent=None, protocol="http", schedule=False, data="none", node_modules=False,
                 card_file=None, apt=(), notify=False):
        self.ws = Path(ws).resolve()
        self.apt, self.notify = set(apt), notify  # what the job config already provides (image packages, notify env)
        self.cron_id, self.agent_override = cron_job, agent
        self.protocol, self.schedule, self.data, self.node_modules = protocol, schedule, data, node_modules
        self.card_file = card_file
        self.disabled = disabled_items(self.ws)  # {(type, id, scope)}
        self.refs = []       # workspace paths the job prompt names (copied with data: none)
        self.models = []     # [{id, region}] bedrock-invoke models the agents call (IAM resources)
        self.blockers, self.warnings, self.notes = [], [], []
        self.paths = {"rewritten": {}, "not_rewritten": [], "history": {}}
        self.iam = {}        # action -> [sources]
        self.missing = {}    # binary -> [sources]
        self.scanned = set()
        self.r = {}

    def blocker(self, what, where, fix=""):
        if not any(b["what"] == what and b["where"] == where for b in self.blockers):
            self.blockers.append({"what": what, "where": where, "fix": fix})

    def warn(self, what, where, fix=""):
        if not any(x["what"] == what and x["where"] == where for x in self.warnings):
            self.warnings.append({"what": what, "where": where, "fix": fix})

    def rel(self, p):
        try:
            return str(Path(p).resolve().relative_to(self.ws))
        except ValueError:
            return str(p).replace(str(Path.home()), "~", 1)

    # Text that is (job=True) part of what the job runs — blockers — or only
    # context the model sees (INDEX.md, inactive skills) — warnings.
    def text(self, text, where, job, base=None, prompt=False):
        add = self.blocker if job else self.warn
        code = code_parts(text)
        for c in code:
            for m in LOCALHOST_RE.finditer(c):
                add(f"local service {m.group(0)}", where, "nothing listens on the host's loopback inside AgentCore — call a reachable endpoint or an AWS API")
            if GPU_RE.search(c):
                add("GPU usage", where, "AgentCore microVMs have no GPU")
        for c in shell_parts(text):
            for tok in commands_in(c):
                if classify_command(tok) == "missing":
                    name = tok.rsplit("/", 1)[-1]
                    if job:
                        self.missing.setdefault(name, []).append(where)
                    else:
                        self.warn(f"binary `{name}` isn't in the image", where)
            self.aws_cli(c, where)
        if not code or not job:
            for m in LOCALHOST_RE.finditer(FENCE_RE.sub("", INLINE_RE.sub("", text))):
                self.warn(f"mentions local service {m.group(0)}", where, "prose only; the model may still try it")
        self.host_paths(text, where, prompt)
        for m in SCRIPT_RE.finditer(text):
            self.script_ref(m.group(1), where, job, base)

    def host_paths(self, text, where, prompt):
        src = str(self.ws)
        for n, line in enumerate(text.splitlines(), 1):
            for m in HOST_PATH_RE.finditer(line):
                p = m.group(0).rstrip(".,;:")
                if p.startswith("~/.halo/global/"):
                    continue  # the image's own HALO_HOME (/home/node/.halo)
                full = os.path.expanduser(p)
                if full == src or full.startswith(src + "/"):
                    if prompt:
                        self.paths["rewritten"][where] = self.paths["rewritten"].get(where, 0) + 1
                    else:
                        self.paths["not_rewritten"].append({"where": f"{where}:{n}", "path": p, "inside": True,
                                                            "fix": f"use a relative path (cwd is the workspace) or {CONTAINER_WS}/…"})
                else:
                    self.paths["not_rewritten"].append({"where": f"{where}:{n}", "path": p, "inside": False,
                                                        "fix": "outside the workspace — doesn't exist in the runtime"})

    def script_ref(self, ref, where, job, base):
        cands = []
        if ref.startswith("~/") or ref.startswith("/"):
            cands.append(Path(os.path.expanduser(ref)))
        else:
            cands.append(self.ws / ref)
            if base:
                cands.append(base / ref)
        for p in cands:
            if p.is_file():
                self.script(p.resolve(), f"{where} → {self.rel(p)}", job)
                return

    def script(self, p, where, job):
        if p in self.scanned:
            return
        self.scanned.add(p)
        t = read_text(p)
        if t is None:
            return
        add = self.blocker if job else self.warn
        name = self.rel(p)
        for m in LOCALHOST_RE.finditer(t):
            add(f"local service {m.group(0)}", name, "nothing listens on the host's loopback inside AgentCore")
        if GPU_RE.search(t):
            add("GPU usage", name, "AgentCore microVMs have no GPU")
        for m in HOST_PATH_RE.finditer(t):
            self.paths["not_rewritten"].append({"where": name, "path": m.group(0), "inside": m.group(0).startswith(str(self.ws)),
                                                "fix": "make it relative to the workspace"})
        if p.suffix == ".py":
            self.python(t, name, p.parent, job)
        elif p.suffix in (".sh", ".bash"):
            for tok in commands_in(t):
                if classify_command(tok) == "missing":
                    (self.missing.setdefault(tok, []).append(name) if job else self.warn(f"binary `{tok}` isn't in the image", name))
            self.aws_cli(t, name)
        elif p.suffix in (".js", ".mjs", ".cjs"):
            for mod in re.findall(r"""(?:require\(|from\s+|import\s*\()\s*['"]([^'"./][^'"]*)['"]""", t):
                if not mod.startswith("node:") and not (self.ws / "node_modules").is_dir():
                    add(f"node module `{mod}` (no node_modules in the workspace)", name)

    def python(self, t, name, here, job):
        add = self.blocker if job else self.warn
        mods = set()
        for line in t.splitlines():
            m = re.match(r"^\s*import\s+(.+)", line)
            if m:
                mods.update(x.strip().split()[0].split(".")[0] for x in m.group(1).split(","))
            m = re.match(r"^\s*from\s+([\w.]+)\s+import", line)
            if m and not m.group(1).startswith("."):
                mods.add(m.group(1).split(".")[0])
        for mod in sorted(mods):
            if mod not in sys.stdlib_module_names and mod not in IMAGE_PY and not (here / f"{mod}.py").exists() and not (here / mod).is_dir():
                pkg = PY_APT.get(mod, f"python3-{mod.lower()}")
                add(f"python module `{mod}` isn't in the image", name,
                    f"stdlib + boto3 + websockets only — deploy.py image --apt {pkg} if Debian bookworm has it")
        for m in re.finditer(r"""subprocess\.\w+\(\s*\[\s*['"]([\w.+/-]+)['"]|os\.system\(\s*['"]([\w.+/-]+)""", t):
            tok = m.group(1) or m.group(2)
            if classify_command(tok) == "missing":
                (self.missing.setdefault(tok, []).append(name) if job else self.warn(f"binary `{tok}` isn't in the image", name))
        self.boto3(t, name)
        self.bedrock_literals(t, name)

    def bedrock_literals(self, t, name):
        """Model ids a script passes to bedrock-runtime (modelId="…"), for the IAM resource list; region =
        the client's literal region_name or the script's *_REGION default when one is spelled out."""
        if "bedrock-runtime" not in t:
            return
        regions = re.findall(r"""region_name\s*=\s*['"]([a-z]{2}-[a-z]+-\d)['"]""", t) or \
            re.findall(r"""_REGION\s*=\s*['"]([a-z]{2}-[a-z]+-\d)['"]""", t)
        for mid in re.findall(r"""modelId\s*=\s*['"]([\w.:-]+)['"]""", t):
            m = {"id": mid, "region": regions[0] if regions else None, "source": name}
            if not any(x["id"] == mid for x in self.models):
                self.models.append(m)
        if "bedrock-mantle" in t:
            for act in ("bedrock-mantle:CreateInference", "bedrock-mantle:CallWithBearerToken"):
                self.add_iam(act, f"{name} (bedrock-mantle responses API)")

    def boto3(self, t, name):
        try:
            import botocore.session
            from botocore import xform_name
        except ImportError:
            self.notes.append("botocore not importable: boto3 permissions not derived")
            return
        bs = botocore.session.get_session()
        clients = {}  # var -> service
        for m in re.finditer(r"""(?:(\w+)\s*=\s*)?[\w.()]*\.client\(\s*['"]([a-z0-9-]+)['"]""", t):
            clients.setdefault(m.group(1) or f"<chain:{m.start()}>", m.group(2))
            chained = re.match(r"""[^)]*\)\.(\w+)\(""", t[m.end():])
            if chained:
                self.boto3_op(bs, xform_name, m.group(2), chained.group(1), name)
        for var, svc in clients.items():
            if var.startswith("<chain"):
                continue
            ops = re.findall(rf"\b{re.escape(var)}\.(\w+)\(", t)
            ops += re.findall(rf"""\b{re.escape(var)}\.get_paginator\(\s*['"](\w+)['"]""", t)
            found = [self.boto3_op(bs, xform_name, svc, op, name) for op in ops]
            if not any(found):
                self.add_iam(f"{svc}:*", f"{name} (boto3 {svc} client, operations not found — narrow by hand)")

    def boto3_op(self, bs, xform_name, svc, method, where):
        overrides = {("bedrock-runtime", "converse"): "bedrock:InvokeModel",
                     ("bedrock-runtime", "converse_stream"): "bedrock:InvokeModelWithResponseStream",
                     ("s3", "upload_file"): "s3:PutObject", ("s3", "upload_fileobj"): "s3:PutObject",
                     ("s3", "download_file"): "s3:GetObject", ("s3", "download_fileobj"): "s3:GetObject"}
        if (svc, method) in overrides:
            self.add_iam(overrides[(svc, method)], f"{where} (boto3 {svc}.{method})")
            return True
        try:
            model = bs.get_service_model(svc)
        except Exception:
            return False
        ops = {xform_name(o): o for o in model.operation_names}
        if method not in ops:
            return False
        prefix = model.metadata.get("signingName") or model.metadata.get("endpointPrefix") or svc
        self.add_iam(f"{prefix}:{ops[method]}", f"{where} (boto3 {svc}.{method})")
        return True

    def aws_cli(self, code, where):
        for m in re.finditer(r"(?:^|[\s;&|(])aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)", code):
            svc, op = m.group(1), m.group(2)
            if svc == "s3":
                acts = {"cp": ["s3:GetObject", "s3:PutObject"], "mv": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                        "sync": ["s3:ListBucket", "s3:GetObject", "s3:PutObject"], "rm": ["s3:DeleteObject"], "ls": ["s3:ListBucket"]}
                for a in acts.get(op, ["s3:*"]):
                    self.add_iam(a, f"{where} (aws s3 {op})")
                continue
            try:
                import botocore.session
                from botocore import xform_name
                model = botocore.session.get_session().get_service_model("s3" if svc == "s3api" else svc)
                ops = {xform_name(o, "-"): o for o in model.operation_names}
                prefix = model.metadata.get("signingName") or model.metadata.get("endpointPrefix") or svc
                self.add_iam(f"{prefix}:{ops[op]}" if op in ops else f"{prefix}:*", f"{where} (aws {svc} {op})")
            except Exception:
                self.add_iam(f"{svc}:*", f"{where} (aws {svc} {op}, not in botocore)")
            self.warn("`aws` CLI isn't in the image", where, "use a boto3 script (python3-boto3 is installed)")

    def add_iam(self, action, src):
        self.iam.setdefault(action, [])
        if src not in self.iam[action]:
            self.iam[action].append(src)

    # ── the scan ──────────────────────────────────────────────────────────
    def run(self):
        r = self.r
        r["workspace"] = str(self.ws)
        if not (self.ws / ".halo").is_dir():
            raise SystemExit(f"{self.ws}: not a Halo workspace (no .halo/)")
        r["protocol"], r["schedule"], r["data"] = self.protocol, self.schedule, self.data
        job = self.cron_job() if (self.schedule or self.cron_id) else None
        if self.schedule and not job:
            self.blocker("no cron job chosen", "cron job", "pass --cron-job <id> (the schedule add-on deploys one local cron job)")
        agent_id = self.agent_override or (job["agent_id"] if job else "default")
        self.agents(agent_id)
        if job:
            self.text(job["user_prompt"], "cron prompt", job=True, prompt=True)
            self.refs = prompt_refs(self.ws, job["user_prompt"])
            self.channels(job)
        if self.protocol == "a2a":
            self.card()
        self.context_docs()
        self.settings_secrets()
        self.copy()
        r["models"] = self.models
        hist = files_mentioning([(x["path"], self.ws / x["path"]) for x in r["copy"]["files"] if x["path"].startswith(".halo/sessions/")],
                                str(self.ws))
        self.paths["history"] = {"files": len(hist), "mentions": sum(hist.values())}
        for name, where in sorted(self.missing.items()):
            pkg = APT.get(name, name)
            if pkg in self.apt:
                self.notes.append(f"binary `{name}` ← apt {pkg} (config)")
                continue
            self.blocker(f"binary `{name}` isn't in the image", ", ".join(sorted(set(where))),
                         f"deploy.py image --apt {pkg}" if pkg else "no package for it — change the prompt / script")
        r["blockers"], r["warnings"], r["notes"] = self.blockers, self.warnings, self.notes
        r["paths"] = self.paths
        r["iam_actions"] = sorted(self.iam)
        r["iam_sources"] = self.iam
        r["apt"] = sorted({APT.get(b, b) for b in self.missing if APT.get(b, b) and APT.get(b, b) not in self.apt})
        return r

    def cron_job(self):
        r = self.r
        jobs = load_cron_jobs(job_id=self.cron_id) if self.cron_id else load_cron_jobs(workspace=self.ws)
        r["cron_jobs_here"] = [{"id": j["id"], "label": j.get("label"), "schedule": j["schedule"]} for j in
                               (jobs if not self.cron_id else load_cron_jobs(workspace=self.ws))]
        if self.cron_id and not jobs:
            raise SystemExit(f"cron job {self.cron_id} not found in {CRON_DB}")
        if not self.cron_id:
            if len(jobs) != 1:
                self.notes.append(f"{len(jobs)} cron jobs for this workspace — pass --cron-job to scan one")
                r["cron_job"] = None
                return None
        job = jobs[0]
        if Path(job["workspace_path"]).resolve() != self.ws:
            raise SystemExit(f"cron job {job['id']} runs in {job['workspace_path']}, not {self.ws}")
        r["cron_job"] = {k: job.get(k) for k in ("id", "label", "agent_id", "schedule", "run_at", "timezone", "targets",
                                                  "session_id", "stateless", "enabled", "active_from", "active_until", "working_dir")}
        r["cron_job"]["chat_session"] = cron_session(job)
        if job.get("working_dir") not in (None, "", "."):
            self.warn(f"cron job runs in folder {job['working_dir']}", "cron job", "/invocations runs at the workspace root — fold the folder into the prompt")
        if job.get("timeout_sec"):
            self.notes.append(f"local timeout {job['timeout_sec']} s isn't carried over (runtime maxLifetime 8 h)")
        return job

    def agents(self, entry):
        """The entry agent plus every agent reachable through `team:` (it may delegate to them)."""
        todo, seen, enabled = [entry], [], []
        while todo:
            aid = todo.pop(0)
            if aid in seen:
                continue
            seen.append(aid)
            if aid != entry and ("agent", aid, "workspace") in self.disabled:
                self.notes.append(f"agent {aid} (team of {entry}) is disabled in this workspace — not copied, not scanned")
                continue
            a = self.agent(aid, via=None if aid == entry else "team")
            if a:
                todo += a["team"]
                enabled += [s for s in a["skills"] if s not in enabled]
        self.r["agent"] = next((x for x in self.r["agents"] if x["id"] == entry), {"id": entry})
        local = self.ws / ".halo" / "agents"
        other = sorted(p.name for p in local.iterdir() if (p / "agent.yaml").is_file() and p.name not in seen
                       and ("agent", p.name, "workspace") not in self.disabled) if local.is_dir() else []
        if other:
            self.notes.append(f"agents not reachable from {entry} (copied, not scanned): {', '.join(other)}")
        self.skills(enabled)

    def agent(self, agent_id, via=None):
        where = f"agent {agent_id}" + (" (team member)" if via else "")
        d, scope = find_agent(self.ws, agent_id)
        if not d:
            self.blocker(f"agent {agent_id} not found", where)
            self.r.setdefault("agents", []).append({"id": agent_id})
            return None
        a = parse_agent_yaml((d / "agent.yaml").read_text(encoding="utf-8", errors="replace"))
        prov = a["model"].get("provider", "")
        runtime, envs = provider_info(prov) if prov else (None, [])
        endpoint = a["model"].get("endpoint", "")
        region = (re.search(r"\.([a-z]{2}-[a-z]+-\d)\.", endpoint) or [None, None])[1]
        info = {"id": agent_id, "scope": scope, "dir": self.rel(d), "provider": prov, "model": a["model"].get("id"),
                "endpoint": endpoint, "region": region, "runtime": runtime, "tools": a["tools"], "skills": a["skills"],
                "team": a["team"], "via": via}
        self.r.setdefault("agents", []).append(info)
        if scope == "global":
            self.warn(f"agent {agent_id} is a global agent", where, "the image has Halo's bundled copy, not yours — copy it into .halo/agents/ to keep edits")
        if runtime in BEDROCK_RUNTIMES:
            for act in BEDROCK_RUNTIMES[runtime]:
                self.add_iam(act, f"model provider {prov} ({agent_id})")
            if runtime == "bedrock-invoke" and a["model"].get("id"):
                m = {"id": a["model"]["id"], "region": region}
                if m not in self.models:
                    self.models.append(m)
        elif prov:
            self.blocker(f"model provider {prov} needs an API key ({', '.join(envs) or 'provider secret'})", where,
                         "the per-session worker gets only an env allowlist (CONTRACT §1b) — switch this agent to a Bedrock provider"
                         + (" or drop it from the team" if via else ""))
        if LOCALHOST_RE.search(endpoint):
            self.blocker(f"model endpoint {endpoint}", where, "a local proxy doesn't exist in the runtime")
        for t in a["tools"]:
            if t in ("relay_send", "a2a_send"):
                self.warn(f"tool {t}", where, "relay targets other workspaces on this server / a2a needs remotes config — neither exists in the runtime")
        if a["system_prompt"]:
            self.text(a["system_prompt"], f"{where} system_prompt", job=True)
        if (d / "AGENT.md").is_file():
            self.text((d / "AGENT.md").read_text(encoding="utf-8", errors="replace"), f"{self.rel(d)}/AGENT.md", job=True, base=d)
        return a

    def skills(self, enabled):
        bundled, tmpl = bundled_skills()
        info = []
        for sid in enabled:
            d, scope = resolve_skill(self.ws, sid)
            if ("skill", sid, scope) in self.disabled:
                info.append({"id": sid, "state": f"disabled ({scope}) — not loaded; the runtime has no halo.db, "
                             + ("so sync leaves it out" if scope == "workspace" else "so the image's copy loads again")})
                if scope != "workspace":
                    self.warn(f"skill {sid} is disabled here but bundled", "halo.db disabled_items",
                              "the runtime would load it — drop it from agent.yaml skills")
                continue
            if not d:
                self.warn(f"skill {sid} listed in agent.yaml but not found", "agent.yaml")
                continue
            entry = {"id": sid, "scope": scope}
            if scope == "global" and sid in bundled:
                if same_tree(d, tmpl / sid if tmpl else None):
                    entry["state"] = "bundled"
                    if sid == "cron":
                        self.notes.append("skill cron manages a cron.db the runtime never runs — " + ("the schedule is EventBridge (deploy.py schedule); pausing = disable the schedule" if self.schedule else "jobs the agent creates there never fire; use the schedule add-on instead"))
                    info.append(entry)
                    # The image's copy is identical, so nothing to report — except the AWS calls its scripts make.
                    for p in sorted(d.rglob("*.py")):
                        t = read_text(p)
                        if t:
                            self.boto3(t, f"skill {sid}/{p.relative_to(d)}")
                            self.bedrock_literals(t, f"skill {sid}/{p.relative_to(d)}")
                    continue
                entry["state"] = "bundled, edited here"
                self.warn(f"global skill {sid} differs from Halo's bundled copy", f"~/.halo/global/skills/{sid}",
                          f"the image has the bundled one — copy yours into .halo/skills/{sid} to keep the edits")
            elif scope == "global":
                entry["state"] = "not in the image"
                self.blocker(f"global skill {sid} isn't bundled with Halo", f"~/.halo/global/skills/{sid}",
                             f"copy it into {self.ws}/.halo/skills/{sid} before sync")
            elif scope == "extension":
                entry["state"] = "not in the image"
                self.blocker(f"skill {sid} comes from an installed extension", self.rel(d), f"copy it into .halo/skills/{sid} before sync")
            else:
                entry["state"] = "copied"
            info.append(entry)
            self.skill_files(d, sid, job=True)
        ws_skills = self.ws / ".halo" / "skills"
        inactive = sorted(p.name for p in ws_skills.iterdir() if p.is_dir() and p.name not in enabled
                          and ("skill", p.name, "workspace") not in self.disabled) if ws_skills.is_dir() else []
        for sid in inactive:
            info.append({"id": sid, "scope": "workspace", "state": "inactive (not in agent.yaml skills — copied, not loaded)"})
            self.skill_files(ws_skills / sid, sid, job=False)
        self.r["skills"] = info

    def skill_files(self, d, sid, job):
        md = d / "SKILL.md"
        self.text(md.read_text(encoding="utf-8", errors="replace"), self.rel(md), job=job, base=d)
        for p in sorted(d.rglob("*")):
            if p.is_file() and p.suffix in (".py", ".sh", ".bash", ".js", ".mjs", ".cjs") and "__pycache__" not in p.parts:
                self.script(p.resolve(), self.rel(p), job)

    def context_docs(self):
        for rel in (".halo/INDEX.md", ".halo/INSTRUCTIONS.md", ".halo/USER.md"):
            p = self.ws / rel
            if p.is_file():
                self.text(p.read_text(encoding="utf-8", errors="replace"), rel, job=False)
        prompts = self.ws / ".halo" / "prompts"
        if prompts.is_dir():
            for p in sorted(prompts.rglob("*.md")):
                self.text(p.read_text(encoding="utf-8", errors="replace"), self.rel(p), job=False)

    def copy(self):
        """The copy set for this `data` choice (CONTRACT §1f), the top-level menu to choose it from, and what it costs."""
        try:
            files, sessions, dropped, missing = copy_set(self.ws, self.data, self.refs, self.node_modules,
                                                         disabled_skip(self.disabled))
        except ValueError as e:
            self.blocker(str(e), "config data")
            files, sessions, dropped, missing = [], [], {}, []
        for x in missing:
            self.blocker(f"data path {x} doesn't exist", "config data")
        listed = []
        total = 0
        for rel, p in files:
            try:
                s = p.lstat().st_size
            except OSError:
                continue
            total += s
            listed.append({"path": rel, "bytes": s})
        hist = []
        for sid in sessions:
            hfiles = session_files(self.ws, sid)
            if not hfiles:
                self.blocker(f"session {sid} has no history files", "config data", "check the id under .halo/sessions/<agent>/")
            for rel, p in hfiles:
                s = p.stat().st_size
                total += s
                hist.append({"path": rel, "bytes": s})
        self.r["copy"] = {"mode": parse_data(self.data)[0] if self.data in ("none", "all", "", None) or isinstance(self.data, list) else "?",
                          "bytes": total, "files": listed + hist, "sessions": sessions, "refs": self.refs,
                          "excluded": sorted(f"{k} ({v})" for k, v in dropped.items())}
        self.r["menu"] = top_level_sizes(self.ws, self.node_modules)
        if total > 200 * 1024 ** 2:
            self.warn(f"copy set is {total / 1024 ** 2:.0f} MB", "config data",
                      "with session dirs each new runtime session id starts from a full copy of it: "
                      "EFS = size × callers, and the first call waits for the copy")
        if (self.ws / "node_modules").is_dir() and not self.node_modules and parse_data(self.data)[0] == "all":
            self.notes.append("node_modules/ isn't copied (host builds; native modules won't load on arm64) — "
                              "set node_modules: true to copy it anyway, or run npm install in the runtime")

    def card(self):
        """protocol a2a: the workspace's .halo/agent-card.json (or config agent_card) — fields Halo's buildCard requires."""
        p = Path(self.card_file) if self.card_file else self.ws / ".halo" / "agent-card.json"
        info = {"path": str(p), "exists": p.is_file()}
        self.r["card"] = info
        if not p.is_file():
            self.warn("no agent card", str(p), "callers see Halo's seeded placeholder (name \"Halo\", no skills) — "
                      "`deploy.py card` prints a draft; save it there or set agent_card: in the job config")
            return
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
        except ValueError as e:
            self.blocker(f"agent card isn't JSON ({e})", str(p))
            return
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not isinstance(c.get("description"), str) \
                or not isinstance(c.get("skills"), list):
            self.blocker("agent card needs string name, string description and array skills", str(p),
                         "Halo answers 500 on the card endpoint otherwise")
            return
        info.update(name=c["name"], skills=len(c["skills"]))
        for i, s in enumerate(c["skills"]):
            miss = [k for k in ("id", "name", "description", "tags") if k not in (s if isinstance(s, dict) else {})]
            if miss:
                self.warn(f"agent card skills[{i}] lacks {', '.join(miss)}", str(p), "A2A AgentSkill requires id, name, description, tags")

    def settings_secrets(self):
        """.halo/settings.yaml can carry provider secrets (api keys) — never synced."""
        p = self.ws / ".halo" / "settings.yaml"
        if not p.is_file():
            return
        t = p.read_text(encoding="utf-8", errors="replace")
        keys = sorted(set(re.findall(r"^([A-Za-z0-9_.-]+):\s*\n\s+secrets:", t, re.M)))
        self.warn(".halo/settings.yaml isn't copied" + (f" (holds secrets for {', '.join(keys)})" if keys else ""),
                  ".halo/settings.yaml", "workspace settings / skill params there don't reach the runtime — "
                  "put non-secret ones in the agent or skill files; provider keys can't go along (Bedrock uses the role)")

    def channels(self, job):
        out = []
        for t in job["targets"]:
            ch = t.get("channelType")
            spec = CHANNELS.get(ch)
            row = {"local": ch, "account": t.get("accountId"), "chat": t.get("chatId")}
            if not spec:
                row["status"] = "no notify channel for this type"
                self.warn(f"cron target {ch}", "cron targets", "notify.py can't reach it")
            elif not spec["ok"] and self.notify:
                row["status"] = "replaced by notify env"
                self.notes.append(f"cron target {ch} → replaced by the config's notify env")
            elif not spec["ok"]:
                row["status"] = "blocked"
                self.blocker(f"cron target {ch} (account {t.get('accountId')})", "cron targets", spec["note"])
            else:
                row["status"] = "ok"
                row["env"] = spec["vars"]
                row["note"] = spec["note"]
                if t.get("chatId"):
                    row["hint"] = f"{spec['chat_var']}={t['chatId']}"
            out.append(row)
        if not job["targets"]:
            self.notes.append("the local job has no push target — pick a channel for notify.py")
        self.r["channels"] = out


# ── report ────────────────────────────────────────────────────────────────

def mb(n):
    return f"{n / 1024 / 1024:.1f} MB" if n >= 102400 else f"{n / 1024:.1f} KB"


def copy_report(r, full=True):
    """The `data` menu (top-level entries + sizes), then what this choice copies — every file when full."""
    c = r["copy"]
    L = [f"DATA      data: {json.dumps(r.get('data') or 'none', ensure_ascii=False)} → {mb(c['bytes'])} in {len(c['files'])} files"
         + (f" (job prompt refs: {', '.join(c['refs'])})" if c.get("refs") else "")]
    L.append("  choices (top-level, always-excluded set left out — pick for `data:`):")
    for x in r.get("menu", [])[:25]:
        L.append(f"    {x['path']:<34} {mb(x['bytes']):>10}  {x['files']} files")
    if len(r.get("menu", [])) > 25:
        L.append(f"    … {len(r['menu']) - 25} more")
    if full:
        L.append("  copies:")
        L += [f"    {x['path']}  ({mb(x['bytes'])})" for x in c["files"]]
        if c["excluded"]:
            L.append("  never copied (found here): " + ", ".join(c["excluded"][:30]) + (" …" if len(c["excluded"]) > 30 else ""))
    else:
        L.append(f"  copies {len(c['files'])} files — `deploy.py sync --dry-run` lists each one")
    return "\n".join(L)


def human(r):
    L = []
    w = L.append
    w(f"AgentCore deploy scan — {r['workspace']}")
    j = r.get("cron_job")
    if j:
        try:
            from deploy import eventbridge_expression  # same conversion the schedule phase uses
            eb = "{} {}".format(*eventbridge_expression(j))
        except Exception as e:  # noqa: BLE001 — shown, not fatal
            eb = f"(can't convert: {e})"
        w(f"cron job  {j['id']} \"{j.get('label') or ''}\" — {j['schedule'] or 'once'} ({j.get('timezone') or 'server tz'}) → {eb}")
        w(f"          agent {j['agent_id']} · chat session {j['chat_session'] or '(stateless, new each run)'} · "
          f"{'enabled' if j.get('enabled') else 'DISABLED'}")
    else:
        w("cron job  (none chosen) — " + ", ".join(f"{x['id']} ({x['schedule']})" for x in r.get("cron_jobs_here", [])))
    for a in r.get("agents", []):
        if a.get("provider"):
            w(f"agent     {a['id']}{' (team)' if a.get('via') else ''} ({a['scope']}, {a['dir']}) · {a['provider']} / "
              f"{a['model']} · runtime {a['runtime']} · tools {', '.join(a['tools']) or '-'}")
    if r.get("card"):
        c = r["card"]
        w(f"card      {c['path']} — " + (f"\"{c.get('name')}\", {c.get('skills')} skills" if c.get("name") else
                                          "present, invalid" if c["exists"] else "MISSING"))
    if r.get("skills") is not None:
        w("skills    " + ("; ".join(f"{s['id']} ({s.get('state', s.get('scope'))})" for s in r["skills"]) or "-"))
    w("")
    w(f"BLOCKERS ({len(r['blockers'])})")
    for b in r["blockers"]:
        w(f"  ✗ {b['what']} — {b['where']}" + (f"\n      → {b['fix']}" if b["fix"] else ""))
    if not r["blockers"]:
        w("  none")
    p = r["paths"]
    w("")
    w("PATHS")
    for where, n in p["rewritten"].items():
        w(f"  ↻ rewritten by sync: {where} → .halo/jobs/<job>.md, {n}× {r['workspace']} → {CONTAINER_WS}")
    if not p["rewritten"]:
        w("  ↻ nothing to rewrite in the job prompt")
    seen = set()
    for x in p["not_rewritten"]:
        key = (x["where"], x["path"])
        if key in seen:
            continue
        seen.add(key)
        w(f"  ! not rewritten: {x['where']}  {x['path']} — {x['fix']}")
    if p["history"].get("files"):
        w(f"  · history: {p['history']['files']} session files mention {r['workspace']} {p['history']['mentions']}× — "
          "kept as-is (old turns show host paths)")
    w("")
    w(f"WARNINGS ({len(r['warnings'])})")
    for x in r["warnings"]:
        w(f"  ! {x['what']} — {x['where']}" + (f" ({x['fix']})" if x["fix"] else ""))
    w("")
    w("IAM — extra actions for the runtime role (job inline policy)")
    for act in r["iam_actions"]:
        w(f"  {act:<44} ← {'; '.join(r['iam_sources'][act])}")
    if not r["iam_actions"]:
        w("  none")
    w("")
    w(copy_report(r, full=False))
    if r.get("models"):
        w("MODELS    " + ", ".join(f"{m['id']} @ {m['region'] or '?'}" for m in r["models"]) + " (Bedrock IAM resources)")
    if r.get("protocol") != "http":
        return "\n".join(L + ([""] + ["NOTES"] + [f"  · {n}" for n in r["notes"]] if r["notes"] else []))
    w("")
    w("CHANNELS  (notify.py env vars on the runtime; values go in the channel env file, never in the workspace)")
    for c in r.get("channels", []):
        if c["status"] == "ok":
            w(f"  ✓ {c['local']} → {' '.join(c['env'])}" + (f"  [{c['hint']}]" if c.get("hint") else "") + f" — {c['note']}")
        else:
            w(f"  ✗ {c['local']} ({c['account']}) — {c['status']}")
    w("  alternatives: FEISHU_APP_ID+FEISHU_APP_SECRET+FEISHU_RECEIVE_ID · SLACK_BOT_TOKEN+SLACK_CHANNEL · "
      "TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID · WECOM_WEBHOOK_KEY · WECOM_BOT_ID+WECOM_BOT_SECRET+WECOM_CHAT_ID")
    if r["notes"]:
        w("")
        w("NOTES")
        for n in r["notes"]:
            w(f"  · {n}")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("workspace")
    ap.add_argument("--protocol", choices=("http", "a2a"), default="http",
                    help="http = POST /invocations (:8080); a2a = A2A JSON-RPC (:9000)")
    ap.add_argument("--schedule", action="store_true", help="the schedule add-on (http only): scan the cron job too")
    ap.add_argument("--cron-job", help="cron job id (default: the workspace's only job)")
    ap.add_argument("--agent", help="agent id (default: the cron job's agent, else default)")
    ap.add_argument("--data", action="append", help="none (default) | all | a path / session:<id> (repeatable)")
    ap.add_argument("--files", action="store_true", help="list every file the copy set holds")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.schedule and a.protocol != "http":
        ap.error("--schedule needs --protocol http (Scheduler can't send A2A-Version)")
    data = "none" if not a.data else a.data[0] if a.data in (["none"], ["all"]) else a.data
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    r = Scan(a.workspace, a.cron_job, a.agent, protocol=a.protocol, schedule=a.schedule, data=data).run()
    print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else human(r) + ("\n\n" + copy_report(r) if a.files else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
