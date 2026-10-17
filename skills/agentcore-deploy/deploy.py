#!/usr/bin/env python3
"""Deploy a Halo workspace to Amazon Bedrock AgentCore Runtime — `halo agentcore`, one runtime per job config.

  python3 deploy.py <phase> -c job.yaml [--dry-run] [phase options]

Base deploy (every runtime):
  scan      dependency report for this config (scan.py with the config's protocol / data / cron job)
  card      print a draft .halo/agent-card.json (protocol a2a) — never writes it
  infra     own EFS (encrypted) + mount targets + EFS SG, access point, execution role (least privilege), FS policy
  image     build + push the arm64 image (node:22-slim + Halo + notify.py)
  runtime   create / update the runtime (A2A :9000 or HTTP :8080), session-dirs mode
  sync      copy the workspace's copy set to the access point (--template: <ap>/.template for new callers)
            — mounted TLS + IAM through the access point in a throwaway amazonlinux container (efs-utils)
  test      one invocation (http: async + wait for the notify log line · a2a: SendMessage blocking)
  status    what exists, ids, last log lines
  gc        list (--apply: delete) session dirs idle for --older-than days + .tmp-* copies older than 1 h
  destroy   schedule, runtime, roles; with --purge-data also access point, mount targets, EFS (= all data), SGs
Schedule add-on (protocol http):
  schedule  EventBridge Scheduler → InvokeAgentRuntime (cron from the local job, or --test-in N one-shot)

--dry-run prints every AWS request (botocore-validated) and every IAM policy (Access Analyzer-validated) and
changes nothing. State: <config dir>/<name>.state.json (ids of what this tool created). Python: stdlib + boto3.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import scan  # noqa: E402

MOUNT = "/mnt/efs"            # runtime mount path (API: /mnt/<name>); HALO_WORKSPACE = the session-dirs base
WORKER_PORT = 9100            # agentcore-front.ts: the worker's fixed loopback port (HALO_PORT must differ)
PORTS = {"http": 8080, "a2a": 9000}
SERVER_PROTOCOL = {"http": "HTTP", "a2a": "A2A"}
NOTIFY_CMD = "python3 /opt/agentcore-deploy/notify.py"
UNIVERSAL_TARGET = "arn:aws:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime"
SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$")   # AgentCore 33–256 + the front's dir-name rule
RUNTIME_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,47}$")
SCHED_NAME_RE = re.compile(r"^[0-9a-zA-Z_.-]{1,64}$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
NOTIFY_VARS = re.compile(r"^(FEISHU|SLACK|TELEGRAM|WECOM)_[A-Z_]+$")
SECRET_NAME_RE = re.compile(r"SECRET|TOKEN|KEY|PASSWORD|HEADERS", re.I)
APT_BASE = ["python3", "python3-boto3", "python3-websockets", "bubblewrap", "git", "ca-certificates", "tini",
            "make", "g++"]  # make/g++: better-sqlite3 / node-pty build from source if no arm64 prebuild matches
LOG = "[AgentCoreDeploy]"
EFS_ACTIONS = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite", "elasticfilesystem:ClientRootAccess"]
EFS_BOX_IMAGE = "amazonlinux:2023"  # amazon-efs-utils is in its repo; Ubuntu / Debian have no package
EFS_BOX_TAG = "halo-agentcore-efs-utils:1"  # built once on the sync host from EFS_BOX_IMAGE + efs-utils + rsync
EFS_BOX_ROOT = "/efs"  # the access point's root dir inside the box
SG_WAIT = 900  # destroy: seconds to wait for a SG's ENIs (AgentCore's linger long after the runtime) before giving up
TMP_GC_AGE = 3600  # gc: seconds after which a front's .tmp-* template copy is abandoned (a copy takes seconds)
HALO_VERSION = "2.0.2"  # image's npm @turmind/halo when the config sets neither halo_version nor halo_tgz — pinned, so builds reproduce


def log(msg):
    print(f"{LOG} {msg}", file=sys.stderr)


def die(msg):
    raise SystemExit(f"{LOG} {msg}")


# ── config ────────────────────────────────────────────────────────────────

def _scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        return json.loads(v) if v[0] == '"' else v[1:-1].replace("''", "'")
    if v.startswith("[") and v.endswith("]"):
        return [_scalar(x) for x in re.findall(r"""'[^']*'|"(?:[^"\\]|\\.)*"|[^,\s][^,]*""", v[1:-1]) if x.strip()]
    if v in ("true", "True", "yes"):
        return True
    if v in ("false", "False", "no"):
        return False
    if v in ("null", "~", ""):
        return None
    return int(v) if re.fullmatch(r"-?\d+", v) else v


def parse_yaml(text):
    """The YAML subset a job config uses (no PyYAML — stdlib only): nested block maps, block lists of scalars or
    maps, flow lists [a, b], quoted / bare scalars, # comments. JSON also works."""
    if text.lstrip().startswith("{"):
        return json.loads(text)
    rows = []
    for line in text.splitlines():
        s = re.sub(r"""\s+#(?=(?:[^'"]|'[^']*'|"[^"]*")*$).*$""", "", line.rstrip())
        if s.strip() and not s.lstrip().startswith("#"):
            rows.append((len(s) - len(s.lstrip()), s.strip()))

    def block(i, ind):
        if i < len(rows) and rows[i][1].startswith("- "):
            out = []
            while i < len(rows) and rows[i][0] == ind and rows[i][1].startswith("- "):
                item = rows[i][1][2:].strip()
                m = re.match(r"^([\w.-]+):\s*(.*)$", item)
                if m and not item.startswith(("'", '"')):
                    rows[i] = (ind + 2, item)  # "- key: v" opens a map at the item's indent
                    val, i = block(i, ind + 2)
                    out.append(val)
                else:
                    out.append(_scalar(item))
                    i += 1
            return out, i
        out = {}
        while i < len(rows) and rows[i][0] == ind:
            m = re.match(r"^([\w.-]+):(?:\s+(.*))?$", rows[i][1])
            if not m:
                raise ValueError(f"config line not understood: {rows[i][1]!r}")
            k, v = m.group(1), m.group(2)
            i += 1
            if v is None or v == "":
                if i < len(rows) and rows[i][0] > ind:
                    out[k], i = block(i, rows[i][0])
                elif i < len(rows) and rows[i][0] == ind and rows[i][1].startswith("- "):
                    out[k], i = block(i, ind)
                else:
                    out[k] = None
            else:
                out[k] = _scalar(v)
        return out, i

    val, i = block(0, rows[0][0]) if rows else ({}, 0)
    if i != len(rows):
        raise ValueError(f"config: unexpected indentation at {rows[i][1]!r}")
    return val


def load_config(path):
    p = Path(path).resolve()
    try:
        c = parse_yaml(p.read_text(encoding="utf-8")) or {}
    except ValueError as e:
        die(f"{p.name}: {e}")
    c["_path"], c["_dir"] = str(p), p.parent
    need = ["name", "workspace", "protocol", "network"]
    miss = [k for k in need if not c.get(k)]
    if miss:
        die(f"{p.name}: missing {', '.join(miss)}")
    if c["protocol"] not in PORTS:
        die(f"protocol must be http or a2a, not {c['protocol']!r}")
    if c.get("schedule") and c["protocol"] != "http":
        die("schedule needs protocol http — EventBridge Scheduler can't send the A2A-Version header an A2A runtime requires")
    if c.get("notify") and c["protocol"] != "http":
        die("notify is for protocol http — an A2A runtime returns results to its caller")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", c["name"]):
        die("name: lowercase letters, digits, '-', 2–31 chars (it names the runtime, roles, access point, schedule group)")
    c["workspace"] = str(Path(os.path.expanduser(c["workspace"])).resolve())
    c.setdefault("region", os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "ap-northeast-1")
    c.setdefault("data", "none")
    c.setdefault("access", "workspace")  # agent shell in bwrap (runs as uid 1000 in the worker); full = no sandbox
    if c["access"] not in ("full", "workspace", "readonly"):
        die(f"access must be full, workspace or readonly, not {c['access']!r}")
    c.setdefault("runtime_name", "halo_" + c["name"].replace("-", "_"))
    if not RUNTIME_NAME_RE.match(c["runtime_name"]):
        die(f"runtime_name {c['runtime_name']!r} must match {RUNTIME_NAME_RE.pattern}")
    c.setdefault("ecr_repo", "halo-agentcore")
    c.setdefault("lifecycle", {})
    c["lifecycle"].setdefault("idle", 60)
    c["lifecycle"].setdefault("max_lifetime", 28800)
    n = c["network"]
    old = [k for k in ("efs", "efs_sg") if k in n]
    if old:
        die(f"{p.name}: network.{' / network.'.join(old)} no longer exist — every deploy creates its own EFS; delete them")
    for k in ("vpc", "subnets"):
        if not n.get(k):
            die(f"network.{k} is required")
    s = c.get("schedule")
    if s:
        s.setdefault("agent", None)
        jid = f"job-{c['name']}-"
        s.setdefault("session_id", jid + "0" * max(0, 33 - len(jid)))
        if not SID_RE.match(s["session_id"]):
            die(f"schedule.session_id {s['session_id']!r} must match {SID_RE.pattern} (it names the job's EFS dir)")
    c["_state_path"] = c["_dir"] / f"{c['name']}.state.json"
    return c


def load_state(c):
    p = c["_state_path"]
    return json.loads(p.read_text()) if p.is_file() else {}


def save_state(c, st):
    p = c["_state_path"]
    p.write_text(json.dumps(st, indent=1, sort_keys=True) + "\n")
    os.chmod(p, 0o600)


def read_env_file(path):
    """KEY=VALUE lines (# comments, optional quotes, optional `export `). Values never printed."""
    out = {}
    p = Path(os.path.expanduser(str(path)))
    if not p.is_file():
        die(f"env_file {p} not found")
    if p.stat().st_mode & 0o077:
        log(f"warning: {p} is readable by group/others — chmod 600 it")
    for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line[7:] if line.startswith("export ") else line
        k, sep, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if not sep or not ENV_NAME_RE.match(k):
            die(f"{p}:{n}: not KEY=VALUE")
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out[k] = v
    return out


def mask(k, v):
    return "***" if SECRET_NAME_RE.search(k) or NOTIFY_VARS.match(k) and not k.endswith(("_TYPE", "_BASE")) else v


# ── AWS plumbing ──────────────────────────────────────────────────────────

class Aws:
    """boto3 clients + dry-run: every mutating call is validated against the botocore model and printed."""

    def __init__(self, region, dry):
        import boto3
        from botocore.config import Config
        self.region, self.dry = region, dry
        self.session = boto3.session.Session(region_name=region)
        self.cfg = Config(read_timeout=900, retries={"max_attempts": 3})
        self._c = {}
        self.account = self.client("sts").get_caller_identity()["Account"]

    def client(self, svc, region=None):
        key = (svc, region or self.region)
        if key not in self._c:
            self._c[key] = self.session.client(svc, region_name=region or self.region, config=self.cfg)
        return self._c[key]

    def call(self, svc, op, show=None, **kw):
        """Mutating call. Dry-run: validate the params against the API model, print, return None."""
        c = self.client(svc)
        if self.dry:
            from botocore.validate import ParamValidator
            model = c.meta.service_model.operation_model(c.meta.method_to_api_mapping[op])
            report = ParamValidator().validate(kw, model.input_shape)
            if report.has_errors():
                die(f"{svc}.{op}: invalid request\n{report.generate_report()}")
            print(f"\n── {svc}.{op}  (validated)")
            print(json.dumps(show if show is not None else kw, indent=1, ensure_ascii=False, default=str))
            return None
        return getattr(c, op)(**kw)

    def validate_policy(self, doc, kind="IDENTITY_POLICY", resource_type=None):
        kw = {"policyDocument": json.dumps(doc), "policyType": kind}
        if resource_type:
            kw["validatePolicyResourceType"] = resource_type
        f = self.client("accessanalyzer").validate_policy(**kw)["findings"]
        bad = [x for x in f if x["findingType"] in ("ERROR", "SECURITY_WARNING")]
        for x in f:
            log(f"  access-analyzer {x['findingType']}: {x['issueCode']} — {x['findingDetails'][:160]}")
        if bad:
            die("policy rejected by Access Analyzer (see above)")
        return f


# ── names ─────────────────────────────────────────────────────────────────

def names(c, aws):
    n = c["name"]
    return {
        "exec_role": f"halo-agentcore-{n}-runtime",
        "sched_role": f"halo-agentcore-{n}-scheduler",
        "ap": f"halo-agentcore-{n}",
        "efs": f"halo-agentcore-{n}",          # file system Name tag + CreationToken (idempotent create)
        "efs_sg": f"halo-agentcore-{n}-efs",
        "ap_path": c["network"].get("ap_root") or f"/halo-agentcore/{n}",
        "group": f"halo-{n}",
        "schedule": f"halo-{n}",
        "repo_uri": f"{aws.account}.dkr.ecr.{c['region']}.amazonaws.com/{c['ecr_repo']}",
        "logs": f"/aws/bedrock-agentcore/runtimes/{c['runtime_name']}-",
    }


# ── scan ──────────────────────────────────────────────────────────────────

def run_scan(c):
    s = c.get("schedule") or {}
    return scan.Scan(c["workspace"], s.get("cron_job") or c.get("cron_job"), c.get("agent") or s.get("agent"),
                     protocol=c["protocol"], schedule=bool(s), data=c["data"], node_modules=bool(c.get("node_modules")),
                     card_file=c.get("agent_card"), apt=c.get("apt") or (), notify=bool(c.get("notify"))).run()


def phase_scan(c, a, aws):
    r = run_scan(c)
    print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else scan.human(r) + "\n\n" + scan.copy_report(r))


# ── card ──────────────────────────────────────────────────────────────────

def draft_card(c, r):
    """A2A card draft from the workspace: name/description from the entry agent, one skill per reachable agent."""
    ws = Path(c["workspace"])
    entry = r["agent"]
    text = lambda p: p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""  # noqa: E731
    first = lambda t, key: (re.search(rf"^{key}:\s*(.+)$", t, re.M) or [None, ""])[1].strip().strip("'\"")  # noqa: E731
    yml = text(ws / ".halo" / "agents" / entry["id"] / "agent.yaml")
    idx = text(ws / ".halo" / "INDEX.md")
    title = (re.search(r"^#\s+(.+)$", idx, re.M) or [None, ws.name])[1].strip()
    skills = []
    for ag in r.get("agents", []):
        if not ag.get("provider"):
            continue
        y = text(ws / ".halo" / "agents" / ag["id"] / "agent.yaml")
        skills.append({"id": ag["id"], "name": first(y, "name") or ag["id"],
                       "description": first(y, "description") or f"Halo agent {ag['id']}",
                       "tags": ["halo", ag["id"]],
                       "examples": []})
    return {"name": first(yml, "name") or title, "description": first(yml, "description") or title,
            "version": "1.0.0", "skills": skills}


def phase_card(c, a, aws):
    r = run_scan(c)
    card = draft_card(c, r)
    dest = Path(c.get("agent_card") or Path(c["workspace"]) / ".halo" / "agent-card.json")
    print(json.dumps(card, ensure_ascii=False, indent=2))
    log(f"draft only — review it (examples, wording), then save it as {dest}"
        + (" (exists already — compare first)" if dest.is_file() else ""))


# ── IAM ───────────────────────────────────────────────────────────────────

def model_arns(aws, models):
    """[resource ARNs] for the bedrock-invoke models: inference profile ARN + the foundation models it routes to
    (GetInferenceProfile), or the foundation model ARN for a plain model id."""
    out = []
    for m in models:
        mid, region = m["id"], m.get("region") or aws.region
        if re.match(r"^(global|us|eu|apac|jp|au|ca|us-gov)\.", mid):
            prof = f"arn:aws:bedrock:{region}:{aws.account}:inference-profile/{mid}"
            out.append(prof)
            try:
                p = aws.client("bedrock", region).get_inference_profile(inferenceProfileIdentifier=mid)
                out += [x["modelArn"] for x in p.get("models", [])]
            except Exception as e:  # noqa: BLE001
                die(f"bedrock get-inference-profile {mid} in {region}: {e}")
        else:
            out.append(f"arn:aws:bedrock:{region}::foundation-model/{mid}")
    return sorted(dict.fromkeys(out))


def exec_policy(c, aws, r, nm, fs_id, ap_arn):
    acct, reg = aws.account, c["region"]
    fs = f"arn:aws:elasticfilesystem:{reg}:{acct}:file-system/{fs_id}"
    st = [
        {"Sid": "EcrPull", "Effect": "Allow",
         "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
         "Resource": f"arn:aws:ecr:{reg}:{acct}:repository/{c['ecr_repo']}"},
        {"Sid": "EcrToken", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
        {"Sid": "LogsWrite", "Effect": "Allow",
         "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
         "Resource": f"arn:aws:logs:{reg}:{acct}:log-group:{nm['logs']}*"},  # the * also covers :log-stream:*
        {"Sid": "LogsDescribe", "Effect": "Allow", "Action": "logs:DescribeLogGroups",
         "Resource": f"arn:aws:logs:{reg}:{acct}:log-group:*"},
        {"Sid": "EfsThisAccessPoint", "Effect": "Allow",
         "Action": EFS_ACTIONS, "Resource": fs, "Condition": {"StringEquals": {"elasticfilesystem:AccessPointArn": ap_arn}}},
        {"Sid": "EfsDescribe", "Effect": "Allow",
         "Action": ["elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeAccessPoints"],
         "Resource": [fs, ap_arn]},
    ]
    acts = set(r["iam_actions"])
    bedrock = sorted(a for a in acts if a.startswith("bedrock:"))
    if bedrock:
        res = model_arns(aws, r["models"])
        if not res:
            die("bedrock actions found but no model ids — set iam.bedrock_models in the config")
        st.append({"Sid": "BedrockModels", "Effect": "Allow", "Action": bedrock, "Resource": res})
    mantle = sorted(a for a in acts if a.startswith("bedrock-mantle:"))
    if mantle:
        # Mantle's resource type is the project; the default project per region (web-search deep gear).
        st.append({"Sid": "BedrockMantle", "Effect": "Allow", "Action": mantle,
                   "Resource": f"arn:aws:bedrock-mantle:*:{acct}:project/*"})
    if "polly:SynthesizeSpeech" in acts:
        st.append({"Sid": "Polly", "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*"})  # lexicon-only resource type
    ignore = set(c.get("iam", {}).get("ignore_actions", []))  # found by the scan, deliberately not granted
    other = sorted(a for a in acts if not a.startswith(("bedrock:", "bedrock-mantle:", "polly:")) and a not in ignore)
    allow = set(c.get("iam", {}).get("allow_actions", []))
    for a in other:
        if a.endswith(":*"):
            die(f"scan found `{a}` (operations not identified) — list the exact actions in iam.allow_actions")
        if a not in allow:
            die(f"scan found {a} ({'; '.join(r['iam_sources'][a])}) — add it to iam.allow_actions to grant it, "
                "or iam.ignore_actions to leave it out; nothing beyond the job's own needs is granted silently")
    extra = c.get("iam", {}).get("statements", [])
    granted = [a for a in other if a in allow] + [a for a in allow if a not in other]
    if granted:
        st.append({"Sid": "ConfiguredActions", "Effect": "Allow", "Action": sorted(set(granted)),
                   "Resource": c.get("iam", {}).get("allow_resources", "*")})
    st += extra
    if c.get("observability", {}).get("xray"):
        st.append({"Sid": "XRay", "Effect": "Allow", "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
                   "Resource": "*"})
        st.append({"Sid": "Metrics", "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
                   "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}}})
    return {"Version": "2012-10-17", "Statement": st}


def exec_trust(aws):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole",
        "Condition": {"StringEquals": {"aws:SourceAccount": aws.account},
                      "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{aws.region}:{aws.account}:*"}}}]}


def sched_trust(aws, nm):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"}, "Action": "sts:AssumeRole",
        "Condition": {"StringEquals": {"aws:SourceAccount": aws.account},
                      "ArnLike": {"aws:SourceArn": f"arn:aws:scheduler:{aws.region}:{aws.account}:schedule-group/{nm['group']}"}}}]}


def sched_policy(runtime_arn):
    return {"Version": "2012-10-17", "Statement": [{
        "Sid": "InvokeThisRuntime", "Effect": "Allow", "Action": "bedrock-agentcore:InvokeAgentRuntime",
        "Resource": [runtime_arn, f"{runtime_arn}/runtime-endpoint/*"]}]}


def put_role(aws, name, trust, policy_name, policy, desc, st, key):
    print(f"\n── IAM role {name}: trust policy")
    print(json.dumps(trust, indent=1))
    aws.validate_policy(trust, "RESOURCE_POLICY", "AWS::IAM::AssumeRolePolicyDocument")
    print(f"── IAM role {name}: inline policy {policy_name}")
    print(json.dumps(policy, indent=1))
    aws.validate_policy(policy)
    iam = aws.client("iam")
    exists = True
    try:
        iam.get_role(RoleName=name)
    except iam.exceptions.NoSuchEntityException:
        exists = False
    if not exists:
        aws.call("iam", "create_role", RoleName=name, AssumeRolePolicyDocument=json.dumps(trust), Description=desc,
                 Tags=[{"Key": "managed-by", "Value": "halo-agentcore-deploy"}],
                 show={"RoleName": name, "Description": desc})
    elif key not in st.get("roles", {}):
        die(f"role {name} exists but this tool didn't create it (not in this config's state file) — pick another name")
    else:
        aws.call("iam", "update_assume_role_policy", RoleName=name, PolicyDocument=json.dumps(trust), show={"RoleName": name})
    aws.call("iam", "put_role_policy", RoleName=name, PolicyName=policy_name, PolicyDocument=json.dumps(policy),
             show={"RoleName": name, "PolicyName": policy_name, "PolicyDocument": "(printed above)"})
    if not aws.dry:
        st.setdefault("roles", {})[key] = name
    return f"arn:aws:iam::{aws.account}:role/{name}"


# ── infra ─────────────────────────────────────────────────────────────────

def own_sg(c, aws, st, key, name, desc):
    """Security group `name` in the VPC: the state's, else one found by name (a run that died before saving), else
    created (egress all, no ingress)."""
    if st.get(key):
        return st[key]
    found = aws.client("ec2").describe_security_groups(Filters=[{"Name": "group-name", "Values": [name]},
                                                                {"Name": "vpc-id", "Values": [c["network"]["vpc"]]}])["SecurityGroups"]
    if found:
        sg = found[0]["GroupId"]
    else:
        res = aws.call("ec2", "create_security_group", GroupName=name, VpcId=c["network"]["vpc"], Description=desc,
                       TagSpecifications=[{"ResourceType": "security-group",
                                           "Tags": [{"Key": "managed-by", "Value": "halo-agentcore-deploy"}]}])
        sg = res["GroupId"] if res else f"<new {name}>"
    if not aws.dry:
        st[key] = sg
        save_state(c, st)
    return sg


def sync_host_sg(c):
    """The SG the EFS SG admits for `sync` / `gc` (the efs box mounts over this host's network): network.sync_sg,
    else this EC2 host's only SG from instance metadata."""
    if c["network"].get("sync_sg"):
        return c["network"]["sync_sg"]
    mac = imds("mac")
    ids = (imds(f"network/interfaces/macs/{mac}/security-group-ids") or "").split() if mac else []
    if not ids:
        die("network.sync_sg is required (no instance metadata here to read the sync host's SG from)")
    if len(ids) != 1:
        die(f"this host has SGs {', '.join(ids)} — set network.sync_sg to the one the EFS SG should admit for sync")
    return ids[0]


def allow_2049(aws, efs_sg, src, what):
    cur = [] if efs_sg.startswith("<") else \
        aws.client("ec2").describe_security_groups(GroupIds=[efs_sg])["SecurityGroups"][0]["IpPermissions"]
    if any(p.get("FromPort") == 2049 and any(g["GroupId"] == src for g in p.get("UserIdGroupPairs", [])) for p in cur):
        log(f"EFS SG {efs_sg}: 2049 from {src} ({what}) already allowed")
        return
    aws.call("ec2", "authorize_security_group_ingress", GroupId=efs_sg, IpPermissions=[{
        "IpProtocol": "tcp", "FromPort": 2049, "ToPort": 2049, "UserIdGroupPairs": [{"GroupId": src, "Description": f"nfs from {what}"}]}])


def fs_policy(aws, fs_id, ap_arn, role_arn):
    """The EFS file system policy: TLS only, through an access point only, and the runtime role through its own
    access point (role_arn None = the two denies alone — destroy without --purge-data, no stale principal kept)."""
    fs = f"arn:aws:elasticfilesystem:{aws.region}:{aws.account}:file-system/{fs_id}"
    st = [{"Sid": "DenyNonTls", "Effect": "Deny", "Principal": {"AWS": "*"}, "Action": "*", "Resource": fs,
           "Condition": {"Bool": {"aws:SecureTransport": "false"}}},
          {"Sid": "DenyWithoutAccessPoint", "Effect": "Deny", "Principal": {"AWS": "*"}, "Action": EFS_ACTIONS, "Resource": fs,
           "Condition": {"Null": {"elasticfilesystem:AccessPointArn": "true"}}}]
    if role_arn:
        st.append({"Sid": "AllowRuntimeRoleViaAP", "Effect": "Allow", "Principal": {"AWS": role_arn}, "Action": EFS_ACTIONS,
                   "Resource": fs, "Condition": {"StringEquals": {"elasticfilesystem:AccessPointArn": ap_arn}}})
    return {"Version": "2012-10-17", "Statement": st}


def ensure_fs_policy(c, aws, st, role_arn):
    """Put the FS policy when it differs from what's there — e.g. the role was recreated and the stored principal
    turned into its old unique id (AROA…); equal = no call."""
    fs_id = st.get("efs_id") or "fs-<new>"
    pol = fs_policy(aws, fs_id, st.get("ap_arn") or "<ap from `infra`>", role_arn)
    efs = aws.client("efs")
    have = None
    if st.get("efs_id"):
        try:
            have = json.loads(efs.describe_file_system_policy(FileSystemId=fs_id)["Policy"])
        except efs.exceptions.PolicyNotFound:
            pass
    if have == pol:
        log(f"EFS {fs_id}: file system policy up to date")
        return
    print(f"\n── EFS {fs_id}: file system policy" + (" (differs from the stored one — re-put)" if have else ""))
    print(json.dumps(pol, indent=1))
    aws.validate_policy(pol, "RESOURCE_POLICY")  # Access Analyzer has no EFS resource type: generic checks
    for i in range(12):
        try:
            aws.call("efs", "put_file_system_policy", FileSystemId=fs_id, Policy=json.dumps(pol),
                     show={"FileSystemId": fs_id, "Policy": "(printed above)"})
            return
        except efs.exceptions.InvalidPolicyException as e:
            # A role created seconds ago isn't a valid principal yet (IAM propagation); nothing else retries.
            if i == 11 or "principal" not in str(e).lower():
                raise
            time.sleep(10)


def phase_infra(c, a, aws, st):
    nm = names(c, aws)
    n, efs, ec2 = c["network"], aws.client("efs"), aws.client("ec2")
    sg = n.get("runtime_sg") or own_sg(c, aws, st, "runtime_sg", f"halo-agentcore-{c['name']}",
                                       f"halo agentcore runtime {c['name']} (egress only)")
    # Own EFS per deploy: no fixed cost (mount targets are free), a static policy no other deploy edits, and
    # destroy --purge-data removes it whole. Its SG admits 2049 from the runtime and the sync host only.
    efs_sg = own_sg(c, aws, st, "efs_sg", nm["efs_sg"], f"halo agentcore {c['name']} EFS (2049 from runtime + sync host)")
    allow_2049(aws, efs_sg, sg, f"halo agentcore {c['name']}")
    allow_2049(aws, efs_sg, sync_host_sg(c), "sync host")
    if c.get("observability", {}).get("endpoint"):
        log(f"observability endpoint {c['observability']['endpoint']}: the runtime SG {sg} egresses everywhere; "
            "the collector's own SG must admit it (a VPC-CIDR rule does)")
    fs_id = st.get("efs_id")
    if not fs_id:
        found = efs.describe_file_systems(CreationToken=nm["efs"])["FileSystems"]
        if found:
            fs_id = found[0]["FileSystemId"]
        else:
            res = aws.call("efs", "create_file_system", CreationToken=nm["efs"], PerformanceMode="generalPurpose",
                           Encrypted=True, ThroughputMode="elastic",
                           Tags=[{"Key": "Name", "Value": nm["efs"]}, {"Key": "managed-by", "Value": "halo-agentcore-deploy"}])
            fs_id = res["FileSystemId"] if res else "fs-<new>"
        if not aws.dry:
            st["efs_id"] = fs_id
            save_state(c, st)
            while efs.describe_file_systems(FileSystemId=fs_id)["FileSystems"][0]["LifeCycleState"] != "available":
                time.sleep(3)
    log(f"EFS {fs_id} (encrypted, elastic)")
    # One mount target per AZ of the runtime's subnets (EFS allows one per AZ), in the EFS SG.
    mts = efs.describe_mount_targets(FileSystemId=fs_id)["MountTargets"] if st.get("efs_id") else []
    azs = {m["AvailabilityZoneName"] for m in mts}
    subnets = {s["SubnetId"]: s for s in ec2.describe_subnets(SubnetIds=n["subnets"])["Subnets"]}
    for sid in n["subnets"]:
        az = subnets[sid]["AvailabilityZone"]
        if az in azs:
            continue
        aws.call("efs", "create_mount_target", FileSystemId=fs_id, SubnetId=sid, SecurityGroups=[efs_sg])
        azs.add(az)
    if not aws.dry:
        while True:
            mts = efs.describe_mount_targets(FileSystemId=fs_id)["MountTargets"]
            if all(m["LifeCycleState"] == "available" for m in mts):
                break
            time.sleep(5)
        st["mount_targets"] = sorted(m["MountTargetId"] for m in mts)
        save_state(c, st)
        log("mount targets " + ", ".join(f"{m['MountTargetId']} ({m['AvailabilityZoneName']} {m['IpAddress']})" for m in mts))
    # Access point: own root dir, POSIX 0:0 (the front is root; worker isolation = mount view + uid).
    ap_arn = st.get("ap_arn")
    if not ap_arn:
        aps = efs.describe_access_points(FileSystemId=fs_id)["AccessPoints"] if st.get("efs_id") else []
        same = [x for x in aps if x.get("RootDirectory", {}).get("Path") == nm["ap_path"]]
        if same and same[0].get("Name") != nm["ap"]:
            die(f"access point {same[0]['AccessPointId']} already roots at {nm['ap_path']} — not ours; set network.ap_root")
        # Ours on our own FS (a run that died before saving it): adopt. Token per FS: EFS refuses a ClientToken
        # already spent on another file system's access point.
        res = same[0] if same else aws.call(
            "efs", "create_access_point", ClientToken=f"{fs_id}-{c['name']}", FileSystemId=fs_id,
            PosixUser={"Uid": 0, "Gid": 0},
            RootDirectory={"Path": nm["ap_path"], "CreationInfo": {"OwnerUid": 0, "OwnerGid": 0, "Permissions": "0755"}},
            Tags=[{"Key": "Name", "Value": nm["ap"]}, {"Key": "managed-by", "Value": "halo-agentcore-deploy"}])
        ap_arn = res["AccessPointArn"] if res else f"arn:aws:elasticfilesystem:{c['region']}:{aws.account}:access-point/fsap-<new>"
        if not aws.dry:
            st["ap_arn"], st["ap_id"], st["ap_path"] = ap_arn, res["AccessPointId"], nm["ap_path"]
            save_state(c, st)
            while efs.describe_access_points(AccessPointId=res["AccessPointId"])["AccessPoints"][0]["LifeCycleState"] != "available":
                time.sleep(3)
    log(f"access point {ap_arn} → {nm['ap_path']}")
    r = run_scan(c)
    if r["blockers"]:
        log(f"{len(r['blockers'])} scan blockers — the role covers what the scan found; fix them before `test`")
    pol = exec_policy(c, aws, r, nm, fs_id, ap_arn)
    role = put_role(aws, nm["exec_role"], exec_trust(aws), "runtime", pol, f"halo agentcore {c['name']} execution role", st, "exec")
    if not aws.dry:
        st["exec_role_arn"] = role
        save_state(c, st)
        (c["_dir"] / f"{c['name']}.exec-policy.json").write_text(json.dumps(pol, indent=1) + "\n")
    ensure_fs_policy(c, aws, st, role)  # after the role: its ARN must exist to be a principal
    log("infra ok" if not aws.dry else "infra dry-run ok")


# ── image ─────────────────────────────────────────────────────────────────

def dockerfile(c, apt_extra, tgz_name):
    apt = " ".join(dict.fromkeys(APT_BASE + list(apt_extra)))
    src = f"/tmp/{tgz_name}" if tgz_name else f"@turmind/halo@{c.get('halo_version', HALO_VERSION)}"
    copy_tgz = f"COPY {tgz_name} /tmp/{tgz_name}\n" if tgz_name else ""
    return f"""# Generated by agentcore-deploy (deploy.py image) — {c['name']}. Halo as an AgentCore runtime:
# root front (session dirs: bind <base>/<sid> at /workspace, unmount the base)
# + the worker as uid/gid 1000 with no capabilities. No USER line (the front needs root), no sudo.
FROM --platform=linux/arm64 node:22-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends {apt} \\
 && rm -rf /var/lib/apt/lists/*
{copy_tgz}RUN umask 022 && npm install -g --omit=dev {src} && rm -rf /tmp/*.tgz /root/.npm \\
 && if command -v sudo >/dev/null; then echo "sudo must not be in the image" >&2; exit 1; fi
# Halo's home = homedir() of the worker user (node, /home/node) — seeded once at build time.
RUN su node -s /bin/sh -c 'HOME=/home/node halo setup --non-interactive' \\
 && test -f /home/node/.halo/global/.template-version && mkdir -p {MOUNT} /workspace
COPY notify.py /opt/agentcore-deploy/notify.py
ENV HALO_RUNTIME_MODE=agentcore-a2a \\
    HALO_PORT={PORTS[c['protocol']]} \\
    HALO_WORKSPACE={MOUNT} \\
    HALO_AGENTCORE_SESSION_DIRS=1 \\
    HALO_LOG_LEVEL=info
EXPOSE {PORTS[c['protocol']]}
# tini as PID 1 reaps orphans reparented to it (setsid / nohup … & from the agent's shell) — node as PID 1 leaves
# them zombies. No -g: the front already forwards SIGTERM to the worker; tini only signals its child, the front.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["halo", "agentcore"]
"""


def halo_db_slots(tgz):
    """halo.db schema version the packaged Halo stamps = its HALO_MIGRATIONS slot count (bundled dist/index.js)."""
    with tarfile.open(tgz) as t:
        js = t.extractfile("package/dist/index.js").read().decode("utf-8", "replace")
    m = re.search(r"HALO_MIGRATIONS = \[\n(.*?)\n\s*\];", js, re.S)
    n = len(re.findall(r"^\s*\(s\) =>", m.group(1), re.M)) if m else 0
    if not n:
        die(f"can't read the halo.db schema version from {Path(tgz).name}")
    return n


def phase_image(c, a, aws, st):
    nm = names(c, aws)
    r = run_scan(c)
    apt_extra = list(c.get("apt") or [])  # only what the user chose; the scan's suggestions are listed, not added
    if r["apt"]:
        log(f"scan suggests apt {' '.join(r['apt'])} (blockers) — add the ones the job needs to `apt:` in the config")
    tgz = c.get("halo_tgz")
    with tempfile.TemporaryDirectory() as d:
        ctx = Path(d)
        if tgz:
            tgz = Path(os.path.expanduser(tgz)).resolve()
            shutil.copy(tgz, ctx / tgz.name)
            slots = halo_db_slots(tgz)
        else:
            spec = f"@turmind/halo@{c.get('halo_version', HALO_VERSION)}"
            name = subprocess.run(["npm", "pack", "--silent", spec], cwd=d, check=True, capture_output=True, text=True).stdout.split()[-1]
            slots = halo_db_slots(ctx / name)
            os.remove(ctx / name)
        shutil.copy(HERE / "notify.py", ctx / "notify.py")
        df = dockerfile(c, apt_extra, tgz.name if tgz else None)
        (ctx / "Dockerfile").write_text(df)
        sha = hashlib.sha256(df.encode() + (tgz.read_bytes() if tgz else b"")).hexdigest()[:12]
        tag = f"{c['name']}-{dt.datetime.now(dt.timezone.utc):%Y%m%d-%H%M%S}"
        uri = f"{nm['repo_uri']}:{tag}"
        print(f"\n── Dockerfile ({'halo tgz ' + tgz.name if tgz else 'npm ' + c.get('halo_version', HALO_VERSION)}, apt extras: {' '.join(apt_extra) or '-'})")
        print(df)
        if aws.dry:
            print(f"── would build linux/arm64 and push {uri} (builder {c.get('builder', 'default')})")
            return
        ecr = aws.client("ecr")
        try:
            ecr.describe_repositories(repositoryNames=[c["ecr_repo"]])
        except ecr.exceptions.RepositoryNotFoundException:
            ecr.create_repository(repositoryName=c["ecr_repo"], imageScanningConfiguration={"scanOnPush": True},
                                  tags=[{"Key": "managed-by", "Value": "halo-agentcore-deploy"}])
            st["ecr_repo_created"] = c["ecr_repo"]
            log(f"ECR repo {c['ecr_repo']} created")
        tok = ecr.get_authorization_token()["authorizationData"][0]["authorizationToken"]
        pw = base64.b64decode(tok).decode().split(":", 1)[1]
        subprocess.run(["docker", "login", "--username", "AWS", "--password-stdin", nm["repo_uri"].split("/")[0]],
                       input=pw, check=True, capture_output=True, text=True)
        cmd = ["docker", "buildx", "build", "--platform", "linux/arm64", "-t", uri, "--push", str(ctx)]
        if c.get("builder"):
            cmd[3:3] = ["--builder", c["builder"]]
        log(" ".join(cmd))
        subprocess.run(cmd, check=True)
        st["image"] = uri
        st["image_halo"] = tgz.name if tgz else c.get("halo_version", HALO_VERSION)
        st["image_sha"] = sha
        st["halo_db_version"] = slots  # sync refuses a carried halo.db newer than this
        save_state(c, st)
        log(f"pushed {uri} (context {sha})")


# ── runtime ───────────────────────────────────────────────────────────────

def runtime_env(c, st, public_url=None):
    env = {"HALO_RUNTIME_MODE": "agentcore-a2a", "HALO_PORT": str(PORTS[c["protocol"]]), "HALO_WORKSPACE": MOUNT,
           "HALO_AGENTCORE_SESSION_DIRS": "1", "HALO_LOG_LEVEL": "info", "HALO_A2A_ACCESS": c["access"],
           "AWS_REGION": c["region"], "AWS_DEFAULT_REGION": c["region"]}
    for k, v in (c.get("env") or {}).items():
        env[k] = str(v)
    if public_url:
        env["HALO_A2A_PUBLIC_URL"] = public_url
    o = c.get("observability") or {}
    if o.get("endpoint"):
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = o["endpoint"]
        env["OTEL_SERVICE_NAME"] = o.get("service_name") or c["name"]
        if o.get("headers"):
            # `${VAR}` in headers comes from headers_file (KEY=VALUE, 0600) so the token never sits in the yaml.
            hv = read_env_file(o["headers_file"]) if o.get("headers_file") else {}
            miss = [k for k in re.findall(r"\$\{(\w+)\}", o["headers"]) if k not in hv]
            if miss:
                die(f"observability.headers: {', '.join(miss)} not in headers_file")
            env["OTEL_EXPORTER_OTLP_HEADERS"] = re.sub(r"\$\{(\w+)\}", lambda m: hv[m.group(1)], o["headers"])
        if "capture_content" in o:
            env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "true" if o["capture_content"] else "false"
    if c["protocol"] == "http" and c.get("notify"):
        env["HALO_AGENTCORE_NOTIFY"] = NOTIFY_CMD
        nv = read_env_file(c["notify"]["env_file"]) if c["notify"].get("env_file") else {}
        nv.update({k: str(v) for k, v in (c["notify"].get("env") or {}).items()})
        bad = [k for k in nv if not NOTIFY_VARS.match(k)]
        if bad:
            die(f"notify env: {', '.join(bad)} aren't notify.py variables (FEISHU_* SLACK_* TELEGRAM_* WECOM_*)")
        env.update(nv)
    if env["HALO_PORT"] == str(WORKER_PORT):
        die(f"HALO_PORT {WORKER_PORT} is the worker's loopback port")
    if len(env) > 50 or any(len(v) > 5000 for v in env.values()):
        die("runtime env: at most 50 variables, values ≤ 5000 chars")
    return env


def runtime_cfg(c, st, public_url=None, update=False):
    n = c["network"]
    cfg = {
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": st.get("image") or "<image from `image`>"}},
        "roleArn": st.get("exec_role_arn") or "<role from `infra`>",
        "networkConfiguration": {"networkMode": "VPC", "networkModeConfig": {
            "securityGroups": [n.get("runtime_sg") or st.get("runtime_sg") or "<sg from `infra`>"], "subnets": n["subnets"]}},
        "protocolConfiguration": {"serverProtocol": SERVER_PROTOCOL[c["protocol"]]},
        "lifecycleConfiguration": {"idleRuntimeSessionTimeout": int(c["lifecycle"]["idle"]),
                                   "maxLifetime": int(c["lifecycle"]["max_lifetime"])},
        # update replaces the whole config: the filesystem goes in every call.
        "filesystemConfigurations": [{"efsAccessPoint": {"accessPointArn": st.get("ap_arn") or "<ap from `infra`>", "mountPath": MOUNT}}],
        "environmentVariables": runtime_env(c, st, public_url),
        "description": f"Halo agentcore {c['name']} ({c['protocol']}{' + schedule' if c.get('schedule') else ''})",
    }
    if c["protocol"] == "a2a":
        cfg["requestHeaderConfiguration"] = {"requestHeaderAllowlist": ["A2A-Version"]}
    if update:
        cfg["metadataConfiguration"] = {"requireMMDSV2": True}  # create has no such field
    return cfg


def shown(cfg):
    out = json.loads(json.dumps(cfg))
    env = out.get("environmentVariables", {})
    for k in env:
        env[k] = mask(k, env[k])
    return out


def invoke_url(region, arn):
    return f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urllib.parse.quote(arn, safe='')}/invocations"


def wait_ready(ctl, rid):
    while True:
        r = ctl.get_agent_runtime(agentRuntimeId=rid)
        if r["status"] == "READY":
            return r
        if "FAILED" in r["status"]:
            die(f"runtime {rid} {r['status']}: {r.get('failureReason')}")
        time.sleep(5)


def phase_runtime(c, a, aws, st):
    ctl = aws.client("bedrock-agentcore-control")
    if not aws.dry and not (st.get("efs_id") and st.get("exec_role_arn")):
        die("run `infra` first (no EFS / execution role in the state file)")
    ensure_fs_policy(c, aws, st, st.get("exec_role_arn") or f"arn:aws:iam::{aws.account}:role/{names(c, aws)['exec_role']}")
    rid = st.get("runtime_id")
    arn = st.get("runtime_arn")
    if not rid:
        found = [x for x in ctl.list_agent_runtimes(maxResults=100)["agentRuntimes"] if x["agentRuntimeName"] == c["runtime_name"]]
        if found:
            die(f"runtime {c['runtime_name']} exists ({found[0]['agentRuntimeId']}) but isn't in {c['_state_path'].name} — not ours")
        cfg = runtime_cfg(c, st)
        res = aws.call("bedrock-agentcore-control", "create_agent_runtime", agentRuntimeName=c["runtime_name"],
                       tags={"managed-by": "halo-agentcore-deploy"}, show=dict(agentRuntimeName=c["runtime_name"], **shown(cfg)), **cfg)
        if aws.dry:
            arn = f"arn:aws:bedrock-agentcore:{c['region']}:{aws.account}:runtime/{c['runtime_name']}-XXXXXXXXXX"
        else:
            rid = res["agentRuntimeId"]
            st.update(runtime_id=rid, runtime_arn=res["agentRuntimeArn"])
            save_state(c, st)
            log(f"runtime {rid} created")
            wait_ready(ctl, rid)
    elif not aws.dry:
        wait_ready(ctl, rid)  # a previous run may have left it CREATING / UPDATING
    arn = st.get("runtime_arn") or arn
    url = invoke_url(c["region"], arn)
    cfg = runtime_cfg(c, st, public_url=url if c["protocol"] == "a2a" else None, update=True)
    aws.call("bedrock-agentcore-control", "update_agent_runtime", agentRuntimeId=rid or "<new id>",
             show=dict(agentRuntimeId=rid or "<new id>", **shown(cfg)), **cfg)
    if not aws.dry:
        rt = wait_ready(ctl, rid)
        st.update(invoke_url=url, runtime_version=rt.get("agentRuntimeVersion"))
        save_state(c, st)
        log(f"runtime {rid} READY (version {rt.get('agentRuntimeVersion')}) — {url}")
        if c["protocol"] == "a2a":
            log(f"A2A remote for a caller's ~/.halo/secrets/a2a-remotes.yaml: card {url}/.well-known/agent-card.json, auth: sigv4")


# ── sync ──────────────────────────────────────────────────────────────────

def imds(path):
    """EC2 instance metadata (IMDSv2) value, or None off EC2."""
    md = "http://169.254.169.254/latest"
    try:
        tok = urllib.request.urlopen(urllib.request.Request(f"{md}/api/token", method="PUT", headers={
            "X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=2).read().decode()
        return urllib.request.urlopen(urllib.request.Request(f"{md}/meta-data/{path}", headers={
            "X-aws-ec2-metadata-token": tok}), timeout=2).read().decode()
    except OSError:
        return None


class EfsBox:
    """The access point's root dir at EFS_BOX_ROOT inside a throwaway privileged amazonlinux container that mounts it
    with efs-utils (`mount -t efs -o tls,iam,accesspoint=…`) — the only way in the FS policy lets through. Nothing to
    install on the sync host but docker. The caller's boto3 credentials go in frozen, as a 0600 file mounted
    read-only at /root/.aws/credentials, deleted on exit; never in argv / env / output."""

    def __init__(self, c, st, aws, stage=None):
        if not (st.get("efs_id") and st.get("ap_id")):
            die("run `infra` first (no EFS / access point in the state file)")
        self.c, self.st, self.aws, self.stage = c, st, aws, stage
        self.name, self.tmp = f"halo-agentcore-efs-{c['name']}-{os.getpid()}", None

    def mount_ip(self):
        if self.c["network"].get("mount_ip"):
            return self.c["network"]["mount_ip"]
        mts = [m for m in self.aws.client("efs").describe_mount_targets(FileSystemId=self.st["efs_id"])["MountTargets"]
               if m["LifeCycleState"] == "available"]
        if not mts:
            die(f"EFS {self.st['efs_id']} has no available mount target — run `infra`")
        az = imds("placement/availability-zone")  # same-AZ mount target when this host is in one of them
        return next((m["IpAddress"] for m in mts if m["AvailabilityZoneName"] == az), mts[0]["IpAddress"])

    def __enter__(self):
        if subprocess.run(["docker", "image", "inspect", EFS_BOX_TAG], capture_output=True).returncode:
            log(f"building {EFS_BOX_TAG} (FROM {EFS_BOX_IMAGE} + amazon-efs-utils rsync — once per host)")
            subprocess.run(["docker", "build", "-q", "-t", EFS_BOX_TAG, "-"], check=True,
                           capture_output=True, text=True,
                           input=f"FROM {EFS_BOX_IMAGE}\nRUN dnf install -y -q amazon-efs-utils rsync findutils && dnf clean all\n")
        try:
            self.tmp = tempfile.mkdtemp(prefix="halo-efs-")  # 0700
            cr = self.aws.session.get_credentials().get_frozen_credentials()
            fd = os.open(f"{self.tmp}/credentials", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(f"[default]\naws_access_key_id = {cr.access_key}\naws_secret_access_key = {cr.secret_key}\n"
                        + (f"aws_session_token = {cr.token}\n" if cr.token else ""))
            vols = ["-v", f"{self.tmp}/credentials:/root/.aws/credentials:ro"]
            if self.stage:
                vols += ["-v", f"{self.stage}:/stage:ro"]
            r = subprocess.run(["docker", "run", "-d", "--rm", "--privileged", "--network", "host", "--name", self.name,
                                *vols, EFS_BOX_TAG, "sleep", "infinity"], capture_output=True, text=True)
            if r.returncode:
                die(f"efs box: docker run → exit {r.returncode}: {r.stderr.strip()[-400:]}")
            opts = f"tls,iam,accesspoint={self.st['ap_id']},region={self.c['region']},mounttargetip={self.mount_ip()}"
            self.run("mkdir", "-p", EFS_BOX_ROOT)
            self.run("mount", "-t", "efs", "-o", opts, f"{self.st['efs_id']}:/", EFS_BOX_ROOT)
            log(f"mounted {self.st['efs_id']} via {self.st['ap_id']} (tls, iam) in container {self.name}")
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def run(self, *cmd, check=True):
        r = subprocess.run(["docker", "exec", self.name, *cmd], capture_output=True, text=True)
        if check and r.returncode:
            die(f"efs box: {' '.join(cmd[:3])} → exit {r.returncode}: {(r.stderr or r.stdout).strip()[-600:]}")
        return r

    def exists(self, p):
        return self.run("test", "-e", p, check=False).returncode == 0

    def __exit__(self, *exc):
        self.run("umount", EFS_BOX_ROOT, check=False)
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)
        if self.tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)
        return False


def job_prompt(c, r):
    """(text, rewritten count) of the job prompt file .halo/jobs/<name>.md — the cron job's prompt, or the config's."""
    s = c.get("schedule") or {}
    if s.get("prompt"):
        text = s["prompt"]
    else:
        jobs = scan.load_cron_jobs(job_id=s.get("cron_job"))
        if not jobs:
            die(f"cron job {s.get('cron_job')} not found — set schedule.prompt or schedule.cron_job")
        text = jobs[0]["user_prompt"]
    return scan.rewrite_source_paths(text, c["workspace"])


def phase_sync(c, a, aws, st):
    r = run_scan(c)
    for b in r["blockers"]:
        if b["where"] == "config data":
            die(f"data: {b['what']}")
    files = [(x["path"], Path(c["workspace"]) / x["path"]) for x in r["copy"]["files"]]
    s = c.get("schedule")
    target = ".template" if a.template else (s["session_id"] if s else None)
    if not target:
        die("sync needs a target: --template (every new caller's dir starts from it) or a schedule.session_id")
    sessions = r["copy"]["sessions"]
    if a.template and sessions:
        die("session: entries can't go in the template — a new caller's dir is seeded without .halo/sessions and "
            "*.db*; carry a session only into the scheduled job's own dir")
    extra = {}
    if c.get("agent_card"):
        # A card kept outside the workspace (e.g. the workspace is someone else's / read-only) lands as the A2A card.
        extra[".halo/agent-card.json"] = Path(os.path.expanduser(c["agent_card"])).read_text(encoding="utf-8")
        files = [(rel, p) for rel, p in files if rel != ".halo/agent-card.json"]
    if s and not a.template:
        text, n = job_prompt(c, r)
        extra[f".halo/jobs/{c['name']}.md"] = text
        others = scan.files_mentioning(files, c["workspace"])
        log(f"job prompt → .halo/jobs/{c['name']}.md ({n}× {c['workspace']} → {scan.CONTAINER_WS})")
        for rel, k in sorted(others.items()):
            if not rel.startswith(".halo/sessions/"):
                log(f"  not rewritten: {rel} mentions {c['workspace']} {k}× — fix by hand if the job reads it")
    print(f"\n── sync → <ap {st.get('ap_path') or names(c, aws)['ap_path']}>/{target}/  "
          f"data: {json.dumps(c['data'], ensure_ascii=False)}  ({scan.mb(r['copy']['bytes'])}, {len(files)} files)")
    print(scan.copy_report(r))
    for k in extra:
        print(f"    {k}  ({'agent card from config' if k.endswith('agent-card.json') else 'generated job prompt'})")
    if sessions:
        print(f"    .halo/halo.db  (generated: agent_sessions rows of {', '.join(sessions)} only — so they resume)")
    if a.template and r["copy"]["bytes"] > 0:
        print(f"  cost: every new runtime session id gets a full copy → EFS ≈ {scan.mb(r['copy']['bytes'])} × callers; "
              "the first call of each new id waits for it")
    if aws.dry:
        return
    stage = Path(tempfile.mkdtemp(prefix="halo-sync-"))
    try:
        for rel, p in files:
            q = stage / rel
            q.parent.mkdir(parents=True, exist_ok=True)
            if p.is_symlink():
                os.symlink(os.readlink(p), q)
            else:
                shutil.copy2(p, q)
        for rel, text in extra.items():
            q = stage / rel
            q.parent.mkdir(parents=True, exist_ok=True)
            q.write_text(text, encoding="utf-8")
        (stage / ".halo").mkdir(exist_ok=True)
        if sessions:
            if not st.get("halo_db_version"):
                die("run `image` first (the state has no Halo schema version to check the carried halo.db against)")
            session_db(c["workspace"], sessions, stage / ".halo" / "halo.db", st["halo_db_version"])
        (stage / ".halo" / "agentcore-sync.json").write_text(json.dumps(
            {"at": time.time(), "source": c["workspace"], "data": c["data"], "files": len(files)}) + "\n")
        with EfsBox(c, st, aws, stage) as box:
            dest = f"{EFS_BOX_ROOT}/{target}"
            if box.exists(dest) and not a.force:
                marker = f"{dest}/.halo/agentcore-sync.json"
                prev = json.loads(box.run("cat", marker).stdout) if box.exists(marker) else None
                if not prev:
                    die(f"<ap>/{target} exists and wasn't written by sync — --force to overwrite")
                if not a.template and runtime_wrote(box, dest, prev):
                    die(f"the runtime has written in {target} since the last sync (sessions / db newer) — --force overwrites its state")
            box.run("mkdir", "-p", dest)
            # No --delete: runtime-created files stay.
            box.run("rsync", "-a", "--no-owner", "--no-group", "/stage/", dest + "/")
            box.run("chown", "-R", "0:0", dest)
            box.run("chmod", "0700", dest)
    finally:
        shutil.rmtree(stage)
    st.setdefault("synced", {})[target] = {"at": time.time(), "files": len(files), "bytes": r["copy"]["bytes"]}
    save_state(c, st)
    log(f"synced {len(files)} files ({scan.mb(r['copy']['bytes'])}) → {st['ap_path']}/{target} on {st['efs_id']}")


def session_db(ws, sessions, dest, max_version):
    """Minimal .halo/halo.db for `session:<id>` data: those sessions' agent_sessions rows (+ disabled_items), nothing
    else. Without its row `/invocations` creates the session afresh and the first save overwrites the carried
    raw.jsonl; with it the session resumes from that history. reply_to is cleared (a local relay / A2A pointer).
    Tech debt: Halo has no session import, so the skill writes halo.db itself. The real fix belongs in Halo
    (`halo sessions import`, or claiming an orphan session log on open), not here."""
    with tempfile.TemporaryDirectory() as d:
        src = scan.db_snapshot(ws, d)
        if not src:
            die("data has session: entries but the workspace has no .halo/halo.db to take their rows from")
        con = sqlite3.connect(src)
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        if ver > max_version:
            die(f"the workspace halo.db is schema v{ver}, the image's Halo knows v{max_version} — rebuild the image "
                "with a Halo at least as new as the one that wrote it")
        have = {r[0] for r in con.execute("SELECT id FROM agent_sessions")}
        miss = [x for x in sessions if x not in have]
        if miss:
            die(f"session {', '.join(miss)} has no row in halo.db")
        q = ",".join("?" * len(sessions))
        con.execute(f"DELETE FROM agent_sessions WHERE id NOT IN ({q})", sessions)
        con.execute("UPDATE agent_sessions SET reply_to = NULL")
        for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
            if t not in ("agent_sessions", "disabled_items"):
                con.execute(f'DELETE FROM "{t}"')
        con.commit()
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("VACUUM")  # deleted rows stay in free pages until rebuilt — other sessions' text must not travel
        if con.execute("PRAGMA freelist_count").fetchone()[0]:
            die("halo.db still has free pages after VACUUM")
        con.close()
        shutil.copy2(src, dest)


def runtime_wrote(box, dest, prev):
    """Has the runtime written in `dest` after the last sync? (newest mtime under .halo/sessions or a db)"""
    out = box.run("find", f"{dest}/.halo", "-newermt", f"@{prev['at'] + 5:.0f}",
                  "(", "-path", "*/sessions/*", "-o", "-name", "*.db", ")", "-print", "-quit", check=False).stdout.strip()
    return bool(out)


# ── schedule ──────────────────────────────────────────────────────────────

def eventbridge_expression(job):
    """Local cron job (5-field cron + IANA tz, or run_at ms) → (Scheduler expression, timezone)."""
    tz = job.get("timezone") or "UTC"
    if job.get("run_at"):
        t = dt.datetime.fromtimestamp(job["run_at"] / 1000, dt.timezone.utc)
        return f"at({t:%Y-%m-%dT%H:%M:%S})", "UTC"
    f = job["schedule"].split()
    if len(f) != 5:
        raise ValueError(f"expected 5 cron fields, got {job['schedule']!r}")
    m, h, dom, mon, dow = f
    # croner: 0/7 = Sunday; EventBridge: 1-7 = SUN-SAT. Names pass through.
    def conv(x):
        if x in ("*", "?"):
            return x
        return re.sub(r"\b([0-7])\b", lambda q: str((int(q.group(1)) % 7) + 1), x)
    if dom != "*" and dow != "*":
        raise ValueError("cron with both day-of-month and day-of-week can't map to EventBridge (one must be ?)")
    if dow == "*":
        dow = "?"
    else:
        dow, dom = conv(dow), "?"
    return f"cron({m} {h} {dom} {mon} {dow} *)", tz


def schedule_input(c, st):
    s = c["schedule"]
    jobs = scan.load_cron_jobs(job_id=s.get("cron_job")) if s.get("cron_job") else []
    chat = s.get("chat_session") or (scan.cron_session(jobs[0]) if jobs else None) or f"job-{c['name']}"
    payload = {"promptFile": f".halo/jobs/{c['name']}.md", "session": chat,
               "id": "<aws.scheduler.schedule-arn>@<aws.scheduler.scheduled-time>",
               "async": True}  # CONTRACT §1d: sync is the default from commit 5 on; a scheduled job wants the receipt
    agent = s.get("agent") or (jobs[0]["agent_id"] if jobs else None)
    if agent:
        payload["agent"] = agent
    return {"AgentRuntimeArn": st.get("runtime_arn") or "<runtime arn>", "RuntimeSessionId": s["session_id"],
            "ContentType": "application/json", "Accept": "application/json", "Payload": json.dumps(payload, ensure_ascii=False)}


def phase_schedule(c, a, aws, st):
    s = c.get("schedule")
    if not s:
        die("no schedule: block in the config (the schedule add-on needs protocol http)")
    nm = names(c, aws)
    if not (SCHED_NAME_RE.match(nm["group"]) and SCHED_NAME_RE.match(nm["schedule"])):
        die("schedule names must match [0-9a-zA-Z-_.]{1,64}")
    rarn = st.get("runtime_arn") or (f"arn:aws:bedrock-agentcore:{c['region']}:{aws.account}:runtime/<id>" if aws.dry else None)
    if not rarn:
        die("run `runtime` first")
    role = put_role(aws, nm["sched_role"], sched_trust(aws, nm), "invoke-runtime", sched_policy(rarn),
                    f"EventBridge Scheduler to halo agentcore {c['name']}", st, "sched")
    sch = aws.client("scheduler")
    try:
        sch.get_schedule_group(Name=nm["group"])
    except sch.exceptions.ResourceNotFoundException:
        aws.call("scheduler", "create_schedule_group", Name=nm["group"], Tags=[{"Key": "managed-by", "Value": "halo-agentcore-deploy"}])
        if not aws.dry:
            st["schedule_group"] = nm["group"]
            time.sleep(10)  # IAM role propagation before the schedule references it
    target = {"Arn": UNIVERSAL_TARGET, "RoleArn": role, "Input": json.dumps(schedule_input(c, st), ensure_ascii=False),
              "RetryPolicy": {"MaximumRetryAttempts": int(s.get("retries", 2)), "MaximumEventAgeInSeconds": int(s.get("max_event_age", 3600))}}
    if a.test_in is not None:
        when = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=a.test_in)
        name = f"{nm['schedule']}-once-{when:%m%d%H%M}"
        kw = dict(Name=name, GroupName=nm["group"], ScheduleExpression=f"at({when:%Y-%m-%dT%H:%M:%S})",
                  ScheduleExpressionTimezone="UTC", FlexibleTimeWindow={"Mode": "OFF"}, State="ENABLED",
                  ActionAfterCompletion="DELETE", Target=target, Description=f"one-shot test of {c['name']}")
    else:
        jobs = scan.load_cron_jobs(job_id=s.get("cron_job")) if s.get("cron_job") else []
        expr, tz = (s["expression"], s.get("timezone", "UTC")) if s.get("expression") else eventbridge_expression(jobs[0])
        name = nm["schedule"]
        kw = dict(Name=name, GroupName=nm["group"], ScheduleExpression=expr, ScheduleExpressionTimezone=tz,
                  FlexibleTimeWindow={"Mode": "OFF"}, State="ENABLED" if a.enable else "DISABLED", Target=target,
                  Description=f"halo agentcore {c['name']}: {jobs[0].get('label') if jobs else ''}"[:512])
    show = json.loads(json.dumps(kw))
    show["Target"]["Input"] = json.loads(show["Target"]["Input"])
    show["Target"]["Input"]["Payload"] = json.loads(show["Target"]["Input"]["Payload"])
    exists = False
    try:
        sch.get_schedule(Name=name, GroupName=nm["group"])
        exists = True
    except sch.exceptions.ResourceNotFoundException:
        pass
    aws.call("scheduler", "update_schedule" if exists else "create_schedule", show=show, **kw)
    if not aws.dry:
        st.setdefault("schedules", [])
        if name not in st["schedules"]:
            st["schedules"].append(name)
        save_state(c, st)
        log(f"schedule {nm['group']}/{name}: {kw['ScheduleExpression']} {kw['ScheduleExpressionTimezone']} {kw['State']}")


# ── test / status ─────────────────────────────────────────────────────────

def agentcore(aws, read_timeout=900):
    import boto3
    from botocore.config import Config
    return boto3.session.Session(region_name=aws.region).client(
        "bedrock-agentcore", config=Config(read_timeout=read_timeout, retries={"max_attempts": 1}))


def log_lines(aws, st, since_ms, pattern):
    lg = f"/aws/bedrock-agentcore/runtimes/{st['runtime_id']}-DEFAULT"
    try:
        ev = aws.client("logs").filter_log_events(logGroupName=lg, startTime=since_ms, filterPattern=pattern)["events"]
    except aws.client("logs").exceptions.ResourceNotFoundException:
        return []
    return [e["message"].strip() for e in sorted(ev, key=lambda e: e["timestamp"])]


def phase_test(c, a, aws, st):
    if not st.get("runtime_arn") and not aws.dry:
        die("run `runtime` first")
    s = c.get("schedule") or {}
    sid = a.session or s.get("session_id") or f"test-{c['name']}-{int(time.time())}".ljust(33, "0")
    if not SID_RE.match(sid):
        die(f"session id {sid!r} must match {SID_RE.pattern}")
    if c["protocol"] == "http":
        # Sync by default (Halo ≥ 2.0.1-39a9623 waits ≤ 10 min and answers the result); --async = the receipt the
        # Scheduler gets, then the notify log line is the proof.
        body = {"id": f"test-{int(time.time())}"}
        if a.async_:
            body["async"] = True
        if a.prompt:
            body["prompt"] = a.prompt
        elif s:
            body["promptFile"] = f".halo/jobs/{c['name']}.md"
            jobs = scan.load_cron_jobs(job_id=s.get("cron_job")) if s.get("cron_job") else []
            body["session"] = s.get("chat_session") or (scan.cron_session(jobs[0]) if jobs else None) or f"job-{c['name']}"
        else:
            body["prompt"] = "Reply with one short line: which workspace are you in, and list its top-level entries."
    else:
        import uuid
        body = {"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": {"message": {
            "messageId": str(uuid.uuid4()), "role": "ROLE_USER",
            "parts": [{"text": a.prompt or "Reply with one short line: who are you and what can you do?"}]}}}
    print(f"\n── invoke_agent_runtime  session {sid}\n{json.dumps(body, ensure_ascii=False, indent=1)}")
    if aws.dry:
        return
    cl = agentcore(aws)
    if c["protocol"] == "a2a":
        cl.meta.events.register("before-sign.bedrock-agentcore.InvokeAgentRuntime",
                                lambda request, **kw: request.headers.__setitem__("A2A-Version", "1.0"))
    t0 = int(time.time() * 1000)
    res = cl.invoke_agent_runtime(agentRuntimeArn=st["runtime_arn"], runtimeSessionId=sid, qualifier="DEFAULT",
                                  contentType="application/json", accept="application/json",
                                  payload=json.dumps(body, ensure_ascii=False).encode())
    out = res["response"].read().decode("utf-8", "replace")
    print(f"── {res.get('statusCode')} ({(time.time() * 1000 - t0) / 1000:.1f} s)\n{out[:4000]}")
    if c["protocol"] == "http":
        try:
            got = json.loads(out)
        except ValueError:
            got = {}
        while got.get("status") == "running" and got.get("invocation"):  # past the 10-min sync cap: poll with get
            time.sleep(30)
            res = cl.invoke_agent_runtime(agentRuntimeArn=st["runtime_arn"], runtimeSessionId=sid, qualifier="DEFAULT",
                                          contentType="application/json", accept="application/json",
                                          payload=json.dumps({"get": got["invocation"]}).encode())
            got = json.loads(res["response"].read().decode("utf-8", "replace"))
            print(f"── get {got.get('invocation')}: {got.get('status')}")
        if got.get("result") is not None and res.get("statusCode") and out != json.dumps(got):
            print(json.dumps(got, ensure_ascii=False, indent=1)[:4000])
    if c["protocol"] == "a2a" or not c.get("notify"):
        return
    log(f"waiting up to {a.wait} s for the notify log line")
    deadline = time.time() + a.wait
    while time.time() < deadline:
        lines = log_lines(aws, st, t0, '"[AgentCore] notify"')
        if lines:
            for line in lines:
                print(line[:1500])
            return
        time.sleep(15)
    die("no `[AgentCore] notify` line yet — `deploy.py status` shows the latest log lines")


def phase_status(c, a, aws, st):
    print(json.dumps({k: v for k, v in st.items() if not k.startswith("_")}, indent=1))
    if st.get("runtime_id"):
        rt = aws.client("bedrock-agentcore-control").get_agent_runtime(agentRuntimeId=st["runtime_id"])
        print(f"runtime {rt['status']} v{rt.get('agentRuntimeVersion')} · {rt['agentRuntimeArtifact']['containerConfiguration']['containerUri']}")
        for line in log_lines(aws, st, int((time.time() - a.since * 60) * 1000), '"[AgentCore"')[-a.lines:]:
            print("  " + line[:300])
    if st.get("schedules"):
        sch = aws.client("scheduler")
        for n in st["schedules"]:
            try:
                x = sch.get_schedule(Name=n, GroupName=names(c, aws)["group"])
                print(f"schedule {n}: {x['ScheduleExpression']} {x.get('ScheduleExpressionTimezone')} {x['State']}")
            except sch.exceptions.ResourceNotFoundException:
                print(f"schedule {n}: gone (one-shot deleted after completion)")


# ── gc / destroy ──────────────────────────────────────────────────────────

def phase_gc(c, a, aws, st):
    """Session dirs under the access point idle for --older-than days (mtime of their .halo/), and the front's
    `.tmp-*` template copies older than TMP_GC_AGE (mtime of the dir itself — one that old was cut off mid-copy).
    Never .template or a scheduled job's dir. Dry-run unless --apply."""
    keep = {".template"} | ({c["schedule"]["session_id"]} if c.get("schedule") else set())
    cut = time.time() - a.older_than * 86400
    with EfsBox(c, st, aws) as box:
        out = box.run("find", EFS_BOX_ROOT, "-mindepth", "1", "-maxdepth", "1", "-type", "d").stdout.split()
        for d in sorted(out):
            name = os.path.basename(d)
            if name in keep:
                continue
            tmp = name.startswith(".tmp-")
            m = box.run("stat", "-c", "%Y", d if tmp else f"{d}/.halo", check=False)
            mt = float(m.stdout.strip() or 0) if m.returncode == 0 else 0
            if tmp and (not mt or mt > time.time() - TMP_GC_AGE):
                continue
            if not tmp and mt and mt > cut:
                continue
            age = (f"{(time.time() - mt) / 3600:.0f} h" if tmp else
                   f"{(time.time() - mt) / 86400:.0f} d" if mt else "no .halo")
            if a.apply:
                box.run("rm", "-rf", "--one-file-system", d)
                log(f"removed {name} ({age})")
            else:
                print(f"would remove {name} ({age})")


def wait_gone(what, probe, limit=600):
    """Poll `probe()` (True = still there) every 5 s up to `limit` s; False on timeout."""
    end = time.time() + limit
    while probe():
        if time.time() > end:
            log(f"{what}: still there after {limit} s")
            return False
        time.sleep(5)
    return True


def delete_sg(aws, sg):
    """Delete a SG once no ENI uses it (AgentCore's runtime ENIs can linger well past the runtime); give up after
    SG_WAIT s and say so — the id stays in the state, a later `destroy` retries."""
    ec2 = aws.client("ec2")
    if aws.dry:
        aws.call("ec2", "delete_security_group", GroupId=sg)
        return True
    if not wait_gone(f"SG {sg} ENIs", lambda: ec2.describe_network_interfaces(
            Filters=[{"Name": "group-id", "Values": [sg]}])["NetworkInterfaces"], SG_WAIT):
        enis = [e["NetworkInterfaceId"] for e in ec2.describe_network_interfaces(Filters=[{"Name": "group-id", "Values": [sg]}])["NetworkInterfaces"]]
        log(f"left in place: SG {sg} — ENIs {', '.join(enis)} not released after {SG_WAIT} s; run `destroy` again later")
        return False
    aws.call("ec2", "delete_security_group", GroupId=sg)
    log(f"SG {sg} deleted")
    return True


def phase_destroy(c, a, aws, st):
    """schedule → runtime → (--purge-data: access point → mount targets → EFS) → roles → (--purge-data: EFS SG) → runtime SG.
    The EFS holds all of this deploy's data, so without --purge-data it stays (with a policy naming no role)."""
    nm = names(c, aws)
    sch, iam, efs, ctl = aws.client("scheduler"), aws.client("iam"), aws.client("efs"), aws.client("bedrock-agentcore-control")
    for n in st.get("schedules", []):
        try:
            aws.call("scheduler", "delete_schedule", Name=n, GroupName=nm["group"])
        except sch.exceptions.ResourceNotFoundException:
            pass
    if st.get("schedule_group"):
        aws.call("scheduler", "delete_schedule_group", Name=st["schedule_group"])
    if st.get("runtime_id"):
        aws.call("bedrock-agentcore-control", "delete_agent_runtime", agentRuntimeId=st["runtime_id"])
        if not aws.dry:
            def rt_there():
                try:
                    ctl.get_agent_runtime(agentRuntimeId=st["runtime_id"])
                    return True
                except ctl.exceptions.ResourceNotFoundException:
                    return False
            wait_gone(f"runtime {st['runtime_id']}", rt_there)
    if a.purge_data and st.get("efs_id"):
        print(f"\n── delete EFS {st['efs_id']} with all its data ({st.get('ap_path')})" + (" (dry-run)" if aws.dry else ""))
        if st.get("ap_id"):
            aws.call("efs", "delete_access_point", AccessPointId=st["ap_id"])
        mts = efs.describe_mount_targets(FileSystemId=st["efs_id"])["MountTargets"]
        for m in mts:
            aws.call("efs", "delete_mount_target", MountTargetId=m["MountTargetId"])
        if not aws.dry:
            wait_gone("mount targets", lambda: efs.describe_mount_targets(FileSystemId=st["efs_id"])["MountTargets"])
        aws.call("efs", "delete_file_system", FileSystemId=st["efs_id"])
        if not aws.dry:
            def fs_there():
                try:
                    return bool(efs.describe_file_systems(FileSystemId=st["efs_id"])["FileSystems"])
                except efs.exceptions.FileSystemNotFound:
                    return False
            wait_gone(f"EFS {st['efs_id']}", fs_there)
            for k in ("efs_id", "mount_targets", "ap_id", "ap_arn", "synced"):
                st.pop(k, None)
            save_state(c, st)
    elif st.get("efs_id"):
        # Kept data: drop the role from the FS policy before the role goes (else it lingers as a dead AROA… id).
        ensure_fs_policy(c, aws, st, None)
    for key, role in st.get("roles", {}).items():
        for p in iam.list_role_policies(RoleName=role)["PolicyNames"]:
            aws.call("iam", "delete_role_policy", RoleName=role, PolicyName=p)
        aws.call("iam", "delete_role", RoleName=role)
    if not aws.dry:
        for k in ("schedules", "schedule_group", "runtime_id", "runtime_arn", "invoke_url", "roles", "exec_role_arn"):
            st.pop(k, None)
        save_state(c, st)
    # EFS SG first: its 2049 rule references the runtime SG, which can't be deleted while referenced.
    if st.get("efs_sg") and a.purge_data:
        if delete_sg(aws, st["efs_sg"]) and not aws.dry:
            st.pop("efs_sg")
            save_state(c, st)
    if st.get("runtime_sg") and not c["network"].get("runtime_sg"):
        if st.get("efs_sg") and not aws.dry:  # kept EFS SG: drop its rule for this runtime SG
            rules = aws.client("ec2").describe_security_group_rules(Filters=[{"Name": "group-id", "Values": [st["efs_sg"]]}])["SecurityGroupRules"]
            ids = [r["SecurityGroupRuleId"] for r in rules if not r["IsEgress"]
                   and (r.get("ReferencedGroupInfo") or {}).get("GroupId") == st["runtime_sg"]]
            if ids:
                aws.call("ec2", "revoke_security_group_ingress", GroupId=st["efs_sg"], SecurityGroupRuleIds=ids)
        if delete_sg(aws, st["runtime_sg"]) and not aws.dry:
            st.pop("runtime_sg")
            save_state(c, st)
    log("left in place: ECR repo + images" + ("" if a.purge_data else
        f", EFS {st.get('efs_id')} + access point + EFS SG (data under {st.get('ap_path')}; --purge-data deletes them)"))


# ── main ──────────────────────────────────────────────────────────────────

PHASES = {"scan": phase_scan, "card": phase_card, "infra": phase_infra, "image": phase_image, "runtime": phase_runtime,
          "sync": phase_sync, "schedule": phase_schedule, "test": phase_test, "status": phase_status, "gc": phase_gc,
          "destroy": phase_destroy}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("phase", choices=PHASES)
    ap.add_argument("-c", "--config", required=True)
    ap.add_argument("--dry-run", action="store_true", help="print validated requests + policies, change nothing")
    ap.add_argument("--json", action="store_true", help="scan: JSON")
    ap.add_argument("--template", action="store_true", help="sync: write <ap>/.template (new callers' starting copy)")
    ap.add_argument("--force", action="store_true", help="sync: overwrite a target the runtime has written in")
    ap.add_argument("--test-in", type=int, metavar="MIN", help="schedule: one-shot at() N minutes from now (deleted after)")
    ap.add_argument("--enable", action="store_true", help="schedule: create the recurring schedule ENABLED (default DISABLED)")
    ap.add_argument("--prompt", help="test: prompt text")
    ap.add_argument("--async", dest="async_", action="store_true", help="test (http): async receipt like the Scheduler, not sync")
    ap.add_argument("--session", help="test: runtime session id (≥ 33 chars)")
    ap.add_argument("--wait", type=int, default=900, help="test: seconds to wait for the notify line")
    ap.add_argument("--since", type=int, default=30, help="status: minutes of log")
    ap.add_argument("--lines", type=int, default=20, help="status: log lines")
    ap.add_argument("--older-than", type=float, default=30, help="gc: days")
    ap.add_argument("--apply", action="store_true", help="gc: delete (default: list)")
    ap.add_argument("--purge-data", action="store_true", help="destroy: also the EFS (all data), its access point, mount targets, SG")
    a = ap.parse_args()
    c = load_config(a.config)
    if a.phase in ("scan", "card"):
        PHASES[a.phase](c, a, None)
        return 0
    aws = Aws(c["region"], a.dry_run)
    st = load_state(c)
    PHASES[a.phase](c, a, aws, st)
    return 0


if __name__ == "__main__":
    sys.exit(main())
