"""A small Cloudflare v4 API client for the gateway's operator tools.

Stdlib only. The token is held by the client and sent as a bearer header; it is
never put in an exception, a log line or output. The HTTP transport is
injectable so tests can fake every call:

    transport(method, url, headers, body_bytes_or_None) -> (status, response_bytes)
"""

import json
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID = "722b682d1c0bb958ea4d14b5bc6275d1"
ZONE_NAME = "dyzzyscards.com"
WORKER_NAME = "tcg-api-gateway"
# Bitwarden key of the Cloudflare API token every operator tool uses (PLAN.md section 7).
CLOUDFLARE_TOKEN_KEY = "TCG_GATEWAY_CLOUDFLARE_API_TOKEN"


class CloudflareError(Exception):
    """A failed Cloudflare call: method, path, HTTP status and Cloudflare error codes. Never the token."""

    def __init__(self, method: str, path: str, status: int, errors: list):
        self.method = method
        self.path = path
        self.status = status
        self.codes = [e.get("code") for e in errors if isinstance(e, dict)]
        messages = "; ".join(str(e.get("message", "")) for e in errors if isinstance(e, dict))[:200]
        super().__init__(f"{method} {path} -> HTTP {status} codes {self.codes} {messages}".rstrip())


def urllib_transport(method: str, url: str, headers: dict, body):
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class CloudflareClient:
    def __init__(self, token: str, transport=None):
        self._token = token
        self._transport = transport or urllib_transport

    def __repr__(self) -> str:
        return "CloudflareClient(<token>)"

    def raw(self, method: str, path: str, body=None) -> tuple[int, dict]:
        """(status, parsed JSON body) without raising on an API error; {} for a non-JSON body."""
        headers = {"Authorization": "Bearer " + self._token, "User-Agent": "tcg-api-gateway-ops"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        status, payload = self._transport(method, API + path, headers, data)
        try:
            parsed = json.loads(payload or b"{}")
        except ValueError:
            parsed = {}
        return status, parsed if isinstance(parsed, dict) else {}

    def call(self, method: str, path: str, body=None):
        """The `result` of a successful call; raises CloudflareError otherwise."""
        status, parsed = self.raw(method, path, body)
        if not (200 <= status < 300 and parsed.get("success") is True):
            raise CloudflareError(method, path, status, parsed.get("errors") or [])
        return parsed.get("result")

    def get(self, path: str):
        return self.call("GET", path)

    def put(self, path: str, body):
        return self.call("PUT", path, body)

    def post(self, path: str, body):
        return self.call("POST", path, body)

    def delete(self, path: str):
        return self.call("DELETE", path)
