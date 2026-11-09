"""Read-only check that the gateway's Cloudflare API token can do every deploy step.

Usage (from a venv with bitwarden-sdk):  python tools/check_cloudflare_token.py

Reads TCG_GATEWAY_CLOUDFLARE_API_TOKEN from Bitwarden (owner-ops) and makes only
GET requests, one per permission the plan needs (PLAN.md section 7). Prints each
check's name and HTTP status, never the token. Exit code 0 only if all pass.
"""

import json
import sys
import urllib.error
import urllib.request

from bitwarden_secrets import bitwarden_client, secret_value

ACCOUNT_ID = "722b682d1c0bb958ea4d14b5bc6275d1"
ZONE_NAME = "dyzzyscards.com"
LICENSES_KV_ID = "3216419ee1244988a05fc0bad9d7b17c"
API = "https://api.cloudflare.com/client/v4"


def get(path: str, token: str) -> tuple[int, dict]:
    request = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token, "User-Agent": "tcg-api-gateway-ops"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except ValueError:
            return error.code, {}


def main() -> int:
    token = secret_value(bitwarden_client(), "TCG_GATEWAY_CLOUDFLARE_API_TOKEN")
    failures = 0

    def check(name: str, path: str, extra=None):
        nonlocal failures
        status, body = get(path, token)
        detail = ""
        passed = status == 200 and body.get("success") is True
        if passed and extra:
            passed, detail = extra(body)
        if not passed and not detail:
            errors = body.get("errors") or []
            detail = "; ".join(str(e.get("message", "")) for e in errors)[:160]
        print(f"{'ok  ' if passed else 'FAIL'} {name:<38} HTTP {status} {detail}".rstrip())
        failures += 0 if passed else 1
        return body if passed else None

    check("token active (account token verify)", f"/accounts/{ACCOUNT_ID}/tokens/verify",
          lambda b: (b["result"].get("status") == "active", "status " + str(b["result"].get("status"))))
    check("Account Settings: Read", f"/accounts/{ACCOUNT_ID}")
    check("Workers Scripts", f"/accounts/{ACCOUNT_ID}/workers/scripts")
    check("Workers KV Storage (LICENSES visible)", f"/accounts/{ACCOUNT_ID}/storage/kv/namespaces?per_page=100",
          lambda b: (any(ns.get("id") == LICENSES_KV_ID for ns in b["result"]), "LICENSES namespace not found"))
    check("Access: Apps", f"/accounts/{ACCOUNT_ID}/access/apps")
    check("Access: Service Tokens", f"/accounts/{ACCOUNT_ID}/access/service_tokens")
    check("Turnstile Sites", f"/accounts/{ACCOUNT_ID}/challenges/widgets")
    zones = check(f"Zone: Read ({ZONE_NAME}, this account)", f"/zones?name={ZONE_NAME}",
                  lambda b: (len(b["result"]) == 1 and b["result"][0]["account"]["id"] == ACCOUNT_ID, "zone missing or in another account"))
    if zones:
        zone_id = zones["result"][0]["id"]
        check("Workers Routes (zone)", f"/zones/{zone_id}/workers/routes")
        check("DNS (zone)", f"/zones/{zone_id}/dns_records?per_page=1")
    else:
        failures += 2
        print("skip Workers Routes / DNS checks: zone not readable")

    print("all checks passed" if failures == 0 else f"{failures} check(s) failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
