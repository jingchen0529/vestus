"""Read-only CDP observation of ttwid; never writes cookies or saves credentials."""
import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

import websocket


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def value_summary(value):
    parts = unquote(value).split("|")
    return {"sha256_20": digest(value), "length": len(value),
            "decoded_parts": [{"length": len(p), "sha256_20": digest(p)} for p in parts]}


def safe_url(value):
    try:
        u = urlsplit(value)
        if u.scheme not in {"http", "https"}:
            return {"scheme": u.scheme}
        return {"host": u.hostname, "path": u.path,
                "query_keys": sorted(set(k for k, _ in parse_qsl(u.query)))}
    except Exception:
        return {"invalid_url": True}


def cookie_summary(cookie):
    return {"domain": cookie.get("domain"), "path": cookie.get("path"),
            "httpOnly": cookie.get("httpOnly"), "secure": cookie.get("secure"),
            "sameSite": cookie.get("sameSite"), "session": cookie.get("session"),
            "expires": cookie.get("expires"), "partitionKey": cookie.get("partitionKey"),
            **value_summary(cookie.get("value", ""))}


def set_cookie_summaries(headers):
    found = []
    for key, raw in headers.items():
        if key.lower() != "set-cookie":
            continue
        for line in str(raw).splitlines():
            name_value, _, attributes = line.partition(";")
            name, sep, value = name_value.partition("=")
            if not sep or name.strip() != "ttwid":
                continue
            attrs = {}
            for piece in attributes.split(";"):
                key, sep, val = piece.strip().partition("=")
                if key.lower() in {"domain", "path", "expires", "max-age", "samesite"}:
                    attrs[key.lower()] = val
                elif key.lower() in {"secure", "httponly", "partitioned"}:
                    attrs[key.lower()] = True
            found.append({**value_summary(value), "attributes": attrs})
    return found


def request_cookie_summaries(headers):
    values = []
    for key, raw in headers.items():
        if key.lower() == "cookie":
            for item in str(raw).split(";"):
                name, sep, value = item.strip().partition("=")
                if sep and name == "ttwid":
                    values.append(value_summary(value))
    return values


def self_test():
    secret = "private-login-token"
    headers = {"Set-Cookie": "sessionid=" + secret + "; HttpOnly\nttwid=1%7Cvisitor-secret%7C123; Domain=.example.test; Path=/; HttpOnly"}
    result = set_cookie_summaries(headers)
    encoded = json.dumps(result)
    assert len(result) == 1 and secret not in encoded and "visitor-secret" not in encoded
    assert result[0]["attributes"]["httponly"] is True
    assert safe_url("https://example.test/login?token=" + secret)["query_keys"] == ["token"]
    assert secret not in json.dumps(safe_url("https://example.test/login?token=" + secret))
    assert safe_url("data:text/plain," + secret) == {"scheme": "data"}
    assert safe_url("blob:https://example.test/" + secret) == {"scheme": "blob"}
    assert request_cookie_summaries({"Cookie": "sessionid=" + secret + "; ttwid=value"}) == [value_summary("value")]
    assert len(set_cookie_summaries({"Set-Cookie": "ttwid=; Max-Age=0"})) == 1
    print("PASS: only ttwid digests and allowlisted attributes survive redaction")


def run(endpoint, output, seconds):
    parsed = urlsplit(endpoint)
    if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Only an existing loopback CDP endpoint is permitted")
    output.parent.mkdir(parents=True, exist_ok=True)
    stream = output.open("x", encoding="utf-8")
    ws = websocket.create_connection(endpoint, timeout=0.25, suppress_origin=True)
    sequence = 0
    pending = {}
    targets = set()
    sessions = {}
    requests = {}
    last_cookies = None
    last_poll = 0
    allowed_methods = {"Target.setDiscoverTargets", "Target.getTargets", "Target.attachToTarget",
                       "Network.enable", "Storage.getCookies", "Network.getResponseBody"}

    def emit(kind, **data):
        row = {"at": datetime.now(timezone.utc).isoformat(), "event": kind, **data}
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        stream.flush()
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def send(method, params=None, session=None, tag=None):
        nonlocal sequence
        assert method in allowed_methods
        sequence += 1
        msg = {"id": sequence, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        pending[sequence] = (method, tag)
        ws.send(json.dumps(msg))

    def attach(info):
        target = info.get("targetId")
        if info.get("type") != "page" or target in targets:
            return
        targets.add(target)
        emit("target", target=target, url=safe_url(info.get("url", "")))
        send("Target.attachToTarget", {"targetId": target, "flatten": True}, tag=target)

    send("Target.setDiscoverTargets", {"discover": True})
    send("Target.getTargets")
    started = time.monotonic()
    emit("started", read_only=True, max_seconds=seconds)
    try:
        while time.monotonic() - started < seconds:
            if time.monotonic() - last_poll >= 0.75 and not any(v[0] == "Storage.getCookies" for v in pending.values()):
                send("Storage.getCookies")
                last_poll = time.monotonic()
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not raw:
                break
            msg = json.loads(raw)
            if "id" in msg:
                method, tag = pending.pop(msg["id"], (None, None))
                result = msg.get("result", {})
                if "error" in msg:
                    emit("cdp_error", method=method, code=msg["error"].get("code"))
                elif method == "Target.getTargets":
                    for info in result.get("targetInfos", []):
                        attach(info)
                elif method == "Target.attachToTarget":
                    sid = result.get("sessionId")
                    if sid:
                        sessions[sid] = tag
                        send("Network.enable", {}, session=sid)
                        emit("network_attached", target=tag)
                elif method == "Storage.getCookies":
                    cookies = [cookie_summary(c) for c in result.get("cookies", []) if c.get("name") == "ttwid"]
                    cookies.sort(key=lambda c: (c.get("domain", ""), c.get("path", ""), json.dumps(c.get("partitionKey"), sort_keys=True)))
                    if cookies != last_cookies:
                        emit("cookie_store_changed", initial=last_cookies is None, cookies=cookies)
                        last_cookies = cookies
                elif method == "Network.getResponseBody":
                    # Only identity-check endpoints are eligible, never login bodies.
                    body = result.get("body", "")
                    if result.get("base64Encoded"):
                        import base64
                        body = base64.b64decode(body).decode("utf-8", errors="replace")
                    try:
                        parsed_body = json.loads(body)
                    except (ValueError, TypeError):
                        emit("ttwid_response", request=tag[1], url=tag[2], json_body=False)
                    else:
                        if isinstance(parsed_body, dict):
                            codes = {k: parsed_body[k] for k in ("status_code", "code", "error_code")
                                     if isinstance(parsed_body.get(k), (int, bool))}
                            redirect = parsed_body.get("redirect_url")
                            emit("ttwid_response", request=tag[1], url=tag[2], json_body=True,
                                 result_codes=codes, has_migrate_info="migrate_info" in parsed_body,
                                 redirect=safe_url(redirect) if isinstance(redirect, str) else None)
                continue
            method = msg.get("method", "")
            p = msg.get("params", {})
            sid = msg.get("sessionId")
            rid = p.get("requestId")
            key = (sid, rid)
            if method == "Target.targetCreated":
                attach(p.get("targetInfo", {}))
            elif method == "Target.targetInfoChanged":
                info = p.get("targetInfo", {})
                if info.get("type") == "page":
                    emit("navigation", target=info.get("targetId"), url=safe_url(info.get("url", "")))
            elif method == "Network.requestWillBeSent":
                request = p.get("request", {})
                url = safe_url(request.get("url", ""))
                requests[key] = url
                if len(requests) > 10000:
                    requests.pop(next(iter(requests)))
                if re.search(r"ttwid|logout|log_out|login|passport|sso", url.get("path", ""), re.I):
                    emit("auth_request", request=rid, target=sessions.get(sid), method=request.get("method"), url=url,
                         ttwid=request_cookie_summaries(request.get("headers", {})))
            elif method in {"Network.responseReceived", "Network.responseReceivedExtraInfo"}:
                response = p.get("response", p)
                headers = response.get("headers", {})
                changed = set_cookie_summaries(headers)
                clear_site_data = next((v for k, v in headers.items() if k.lower() == "clear-site-data"), None)
                if changed or clear_site_data:
                    emit("response_cookie_directive", source=method, request=rid, target=sessions.get(sid),
                         url=safe_url(response["url"]) if "url" in response else requests.get(key),
                         status=response.get("status", p.get("statusCode")), ttwid=changed,
                         clear_site_data=clear_site_data)
            elif method == "Network.loadingFinished":
                url = requests.get(key, {})
                if url.get("path") in {"/ttwid/check/", "/ttwid/union/register/", "/ttwid/register/"}:
                    send("Network.getResponseBody", {"requestId": rid}, session=sid, tag=(sid, rid, url))
    except KeyboardInterrupt:
        emit("stopped_by_operator")
    finally:
        ws.close()
        stream.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--port-file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--seconds", type=int, default=900)
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if not args.port_file or not args.output:
            parser.error("--port-file and --output are required")
        port, path, *_ = args.port_file.read_text().splitlines()
        if not port.isdigit() or not path.startswith("/devtools/browser/"):
            raise SystemExit("Invalid DevToolsActivePort format")
        run(f"ws://127.0.0.1:{port}{path}", args.output, args.seconds)
