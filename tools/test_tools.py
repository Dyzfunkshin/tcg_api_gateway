"""Offline tests for the operator tools (cloudflare_api, push_secrets, cutover).

Run: python tools/test_tools.py
Fakes only: a fake Cloudflare transport that records every call and a fake Bitwarden
store. Nothing here reaches the network, Bitwarden or Credential Manager.
"""

import contextlib
import io
import json
import pathlib
import sys
import types
import unittest
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import cloudflare_api  # noqa: E402
import create_app_key  # noqa: E402
import cutover  # noqa: E402
import push_secrets  # noqa: E402
from cloudflare_api import ACCOUNT_ID, CloudflareClient, CloudflareError  # noqa: E402

A = f"/accounts/{ACCOUNT_ID}"
CF_TOKEN = "CF-TOKEN-must-never-print-0001"
VALUES = {
    "PRICING_APP_TOKEN": "PRICING-VALUE-never-print-0002",
    "CATALOG_APP_TOKEN": "CATALOG-VALUE-never-print-0003",
    "TCG_GATEWAY_TURNSTILE_SECRET": "TURNSTILE-VALUE-never-print-0004",
    "TCG_GATEWAY_SESSION_SIGNING_KEY": "SESSION-VALUE-never-print-0005",
    cloudflare_api.CLOUDFLARE_TOKEN_KEY: CF_TOKEN,
}
ACCESS_CLIENT_ID = "access-client-id-never-print-0006.access"
ACCESS_CLIENT_SECRET = "ACCESS-SECRET-never-print-0007"
PRODUCTION_VARS = {
    "POLAR_API_BASE": "https://api.polar.sh",
    "PRICING_ORIGIN": "https://pricing-origin.dyzzyscards.com",
    "CATALOG_ORIGIN": "https://catalog-origin.dyzzyscards.com",
}
SANDBOX_VARS = {**PRODUCTION_VARS, "POLAR_API_BASE": "https://sandbox-api.polar.sh"}
G3, G4 = cutover.G3_PHRASE, cutover.G4_PHRASE


class FakeStore:
    """Bitwarden by key; shares an event log with the fake Cloudflare to check ordering."""

    def __init__(self, events, values=None, fail_put=False):
        self.events = events
        self.values = dict(VALUES if values is None else values)
        self.fail_put = fail_put

    def get(self, key):
        return self.values.get(key)

    def put(self, key, value, project_id, note):
        if self.fail_put:
            raise push_secrets.SecretStoreError(f"could not store Bitwarden secret {key}")
        assert project_id == push_secrets.API_GATEWAY_PROJECT_ID
        self.events.append(("bitwarden.put", key))
        self.values[key] = value


class FakeCloudflare:
    """A stateful fake of the Cloudflare endpoints the tools use; records every call."""

    def __init__(self, events, *, domain_service="sourcery-gateway", mintuition_service=None, route=False, fail=()):
        self.events = events
        self.calls = []
        self.fail = set(fail)  # (method, path, service-or-None) tuples to fail with HTTP 500
        self.scripts = ["sourcery-gateway", "tcg-api-gateway"]
        self.domains = ([{"id": "dom1", "hostname": "api.dyzzyscards.com", "service": domain_service,
                          "zone_id": "zone1", "environment": "production"}] if domain_service else [])
        if mintuition_service:  # api.mintuition.app (zone2); attached to nothing unless a test says so
            self.domains.append({"id": "dom2", "hostname": "api.mintuition.app", "service": mintuition_service,
                                 "zone_id": "zone2"})
        self.routes = [{"id": "r1", "pattern": "api.dyzzyscards.com/*", "script": "sourcery-gateway"}] if route else []
        self.worker_secrets = {}
        self.tokens, self.policies, self.apps = [], [], []
        self.ids = 0

    def _id(self):
        self.ids += 1
        return f"id{self.ids}"

    def transport(self, method, url, headers, body):
        assert url.startswith(cloudflare_api.API), url
        assert headers["Authorization"] == "Bearer " + CF_TOKEN
        path = url[len(cloudflare_api.API):]
        data = json.loads(body) if body else None
        self.calls.append((method, path, data))
        self.events.append(("cloudflare", method, path, (data or {}).get("name") or (data or {}).get("service")))
        if (method, path.split("?")[0], (data or {}).get("service")) in self.fail:
            return 500, json.dumps({"success": False, "errors": [{"code": 10000, "message": "boom"}]}).encode()
        result = self.route(method, path, data)
        if method == "DELETE" and path.startswith(f"{A}/workers/domains/"):
            return 204, b""  # what Cloudflare really sends (G3 run, 2026-11-10)
        return 200, json.dumps({"success": True, "errors": [], "result": result}).encode()

    def route(self, method, path, data):
        bare, _, query = path.partition("?")
        secrets_path = f"{A}/workers/scripts/tcg-api-gateway/secrets"
        if (method, bare) == ("GET", f"{A}/workers/scripts"):
            return [{"id": s} for s in self.scripts]
        if (method, bare) == ("GET", f"{A}/workers/domains"):
            host = urllib.parse.parse_qs(query).get("hostname", [None])[0]
            return [d for d in self.domains if host in (None, d["hostname"])]
        if (method, bare) == ("PUT", f"{A}/workers/domains"):
            self.domains = [d for d in self.domains if d["hostname"] != data["hostname"]]
            self.domains.append({"id": self._id(), **data})
            return self.domains[-1]
        if method == "DELETE" and bare.startswith(f"{A}/workers/domains/"):
            self.domains = [d for d in self.domains if d["id"] != bare.rsplit("/", 1)[1]]
            return None
        if (method, bare) == ("GET", "/zones"):
            zones = [{"id": "zone1", "name": "dyzzyscards.com"}, {"id": "zone2", "name": "mintuition.app"}]
            name = urllib.parse.parse_qs(query).get("name", [None])[0]
            return [z for z in zones if name in (None, z["name"])]
        if (method, bare) == ("GET", "/zones/zone1/workers/routes"):
            return self.routes
        if (method, bare) == ("GET", "/zones/zone2/workers/routes"):
            return []
        if (method, bare) == ("GET", secrets_path):
            return [{"name": n, "type": "secret_text"} for n in self.worker_secrets]
        if (method, bare) == ("PUT", secrets_path):
            assert data["type"] == "secret_text"
            self.worker_secrets[data["name"]] = data["text"]
            return {"name": data["name"], "type": "secret_text"}
        if method == "DELETE" and bare.startswith(secrets_path + "/"):
            self.worker_secrets.pop(bare.rsplit("/", 1)[1], None)
            return None
        if (method, bare) == ("GET", f"{A}/access/service_tokens"):
            return [{k: t[k] for k in ("id", "name", "client_id")} for t in self.tokens]
        if (method, bare) == ("POST", f"{A}/access/service_tokens"):
            self.tokens.append({"id": self._id(), "name": data["name"], "client_id": ACCESS_CLIENT_ID,
                                "client_secret": ACCESS_CLIENT_SECRET})
            return self.tokens[-1]
        if method == "DELETE" and bare.startswith(f"{A}/access/service_tokens/"):
            self.tokens = [t for t in self.tokens if t["id"] != bare.rsplit("/", 1)[1]]
            return None
        if (method, bare) == ("GET", f"{A}/access/policies"):
            return self.policies
        if (method, bare) == ("POST", f"{A}/access/policies"):
            self.policies.append({"id": self._id(), **data})
            return self.policies[-1]
        if (method, bare) == ("GET", f"{A}/access/apps"):
            return self.apps
        if (method, bare) == ("POST", f"{A}/access/apps"):
            self.apps.append({"id": self._id(), **data})
            return self.apps[-1]
        raise AssertionError(f"unexpected call {method} {path}")

    def mutations(self):
        return [(m, p, d) for m, p, d in self.calls if m != "GET"]


class Harness:
    def __init__(self, store_values=None, store_fail_put=False, answers=(G3, G4), **cloudflare):
        self.events = []
        self.cf = FakeCloudflare(self.events, **cloudflare)
        self.store = FakeStore(self.events, store_values, store_fail_put)
        self.answers = list(answers)
        self.prompts = 0
        self.stdout = self.stderr = ""

    def input_fn(self, _prompt):
        self.prompts += 1
        if not self.answers:
            raise EOFError
        return self.answers.pop(0)

    def factories(self):
        return {"open_store": lambda: self.store,
                "open_cloudflare": lambda store: CloudflareClient(store.get(cloudflare_api.CLOUDFLARE_TOKEN_KEY),
                                                                  self.cf.transport)}

    def _capture(self, fn):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fn()
        self.stdout += out.getvalue()
        self.stderr += err.getvalue()
        return code

    def cutover(self, argv=("--apply",), variables=PRODUCTION_VARS):
        return self._capture(lambda: cutover.main(list(argv), input_fn=self.input_fn, variables=variables,
                                                  **self.factories()))

    def push(self, argv):
        return self._capture(lambda: push_secrets.main(list(argv), **self.factories()))

    def secret_values(self):
        return set(VALUES.values()) | {ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET} | set(self.store.values.values())


def unreachable():
    raise AssertionError("plan mode must not open Bitwarden or Cloudflare")


class CloudflareClientTests(unittest.TestCase):
    def test_error_carries_status_and_codes_never_the_token(self):
        def transport(method, url, headers, body):
            return 403, json.dumps({"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]}).encode()
        client = CloudflareClient(CF_TOKEN, transport)
        with self.assertRaises(CloudflareError) as caught:
            client.get("/accounts/x/workers/scripts")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.codes, [10000])
        self.assertNotIn(CF_TOKEN, str(caught.exception))
        self.assertNotIn(CF_TOKEN, repr(client))

    def test_empty_2xx_is_success(self):
        # Regression (G3 run, 2026-11-10): Cloudflare answers a custom-domain DELETE with 204 and no
        # body; treating that as an error left api.dyzzyscards.com detached with nothing to roll back.
        client = CloudflareClient(CF_TOKEN, lambda method, url, headers, body: (204, b""))
        self.assertIsNone(client.delete("/accounts/x/workers/domains/d1"))

    def test_non_json_error_body(self):
        client = CloudflareClient(CF_TOKEN, lambda *a: (502, b"<html>bad gateway</html>"))
        with self.assertRaises(CloudflareError) as caught:
            client.delete("/x")
        self.assertEqual(caught.exception.status, 502)


class PushSecretsTests(unittest.TestCase):
    def test_plan_mode_contacts_nothing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = push_secrets.main(["--generate-session-key"], open_store=unreachable, open_cloudflare=unreachable)
        self.assertEqual(code, 0)
        self.assertIn("SESSION_SIGNING_KEY", out.getvalue())

    def test_push_sends_one_put_per_secret(self):
        h = Harness()
        self.assertEqual(h.push(["--only", "PRICING_APP_TOKEN", "--only", "CATALOG_APP_TOKEN", "--apply"]), 0)
        path = f"{A}/workers/scripts/tcg-api-gateway/secrets"
        self.assertEqual(h.cf.mutations(), [
            ("PUT", path, {"name": "PRICING_APP_TOKEN", "text": VALUES["PRICING_APP_TOKEN"], "type": "secret_text"}),
            ("PUT", path, {"name": "CATALOG_APP_TOKEN", "text": VALUES["CATALOG_APP_TOKEN"], "type": "secret_text"}),
        ])

    def test_missing_secret_is_named_and_not_pushed(self):
        values = {k: v for k, v in VALUES.items() if k != "CATALOG_APP_TOKEN"}
        h = Harness(store_values=values)
        self.assertEqual(h.push(["--only", "PRICING_APP_TOKEN", "--only", "CATALOG_APP_TOKEN", "--apply"]), 1)
        self.assertIn("Bitwarden secret CATALOG_APP_TOKEN not found", h.stderr)
        self.assertEqual(set(h.cf.worker_secrets), {"PRICING_APP_TOKEN"})

    def test_access_pair_half_missing_pushes_neither(self):
        h = Harness(store_values={**VALUES, "TCG_GATEWAY_ACCESS_CLIENT_ID": ACCESS_CLIENT_ID})
        self.assertEqual(h.push(["--only", "ACCESS_CLIENT_ID", "--only", "ACCESS_CLIENT_SECRET", "--apply"]), 1)
        self.assertEqual(h.cf.worker_secrets, {})

    def test_access_pair_second_push_failure_removes_first(self):
        values = {**VALUES, "TCG_GATEWAY_ACCESS_CLIENT_ID": ACCESS_CLIENT_ID,
                  "TCG_GATEWAY_ACCESS_CLIENT_SECRET": ACCESS_CLIENT_SECRET}
        h = Harness(store_values=values)
        path = f"{A}/workers/scripts/tcg-api-gateway/secrets"
        original = h.cf.transport

        def transport(method, url, headers, body):
            if method == "PUT" and body and json.loads(body)["name"] == "ACCESS_CLIENT_SECRET":
                return 500, json.dumps({"success": False, "errors": [{"code": 1, "message": "boom"}]}).encode()
            return original(method, url, headers, body)
        h.cf.transport = transport
        self.assertEqual(h.push(["--only", "ACCESS_CLIENT_ID", "--only", "ACCESS_CLIENT_SECRET", "--apply"]), 1)
        self.assertEqual(h.cf.worker_secrets, {})
        self.assertIn(("DELETE", f"{path}/ACCESS_CLIENT_ID", None), h.cf.calls)

    def test_generate_session_key_stores_then_pushes_without_display(self):
        h = Harness()
        self.assertEqual(h.push(["--generate-session-key", "--apply"]), 0)
        key = h.store.values["TCG_GATEWAY_SESSION_SIGNING_KEY"]
        self.assertNotEqual(key, VALUES["TCG_GATEWAY_SESSION_SIGNING_KEY"])
        self.assertGreaterEqual(len(key), 43)  # 32 bytes, base64url
        self.assertEqual(h.cf.worker_secrets, {"SESSION_SIGNING_KEY": key})
        self.assertEqual(h.events[0], ("bitwarden.put", "TCG_GATEWAY_SESSION_SIGNING_KEY"))
        self.assertNotIn(key, h.stdout + h.stderr)

    def test_bitwarden_store_creates_or_updates_by_key(self):
        calls = []
        identifiers = [types.SimpleNamespace(id="s1", key="EXISTING")]
        ok = types.SimpleNamespace(success=True, data=types.SimpleNamespace(data=identifiers))
        api = types.SimpleNamespace(
            list=lambda org: ok,
            create=lambda **kw: calls.append(("create", kw["key"], kw["project_ids"])) or ok,
            update=lambda **kw: calls.append(("update", kw["id"], kw["key"])) or ok,
        )
        store = push_secrets.BitwardenStore(types.SimpleNamespace(secrets=lambda: api), organization_id="org")
        store.put("NEW", "v", "proj", "n")
        store.put("EXISTING", "v", "proj", "n")
        self.assertEqual(calls, [("create", "NEW", ["proj"]), ("update", "s1", "EXISTING")])
        self.assertIsNone(store.get("ABSENT"))


class CutoverTests(unittest.TestCase):
    def test_plan_mode_contacts_nothing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cutover.main([], open_store=unreachable, open_cloudflare=unreachable,
                                input_fn=unreachable, variables=SANDBOX_VARS)
        self.assertEqual(code, 0)
        self.assertIn("WILL REFUSE", out.getvalue())

    def test_sandbox_polar_refuses_cutover(self):
        h = Harness()
        self.assertEqual(h.cutover(variables=SANDBOX_VARS), 1)
        self.assertIn("not Polar production", h.stderr)
        self.assertEqual(h.cf.calls, [])
        self.assertEqual(h.prompts, 0)

    def test_full_run_moves_domain_and_locks_in_order(self):
        h = Harness()
        self.assertEqual(h.cutover(), 0, h.stderr)
        self.assertEqual(sorted((d["hostname"], d["service"]) for d in h.cf.domains),
                         [("api.dyzzyscards.com", "tcg-api-gateway"), ("api.mintuition.app", "tcg-api-gateway")])
        self.assertEqual(set(h.cf.worker_secrets), {"PRICING_APP_TOKEN", "CATALOG_APP_TOKEN",
                                                   "ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET"})
        self.assertEqual(h.cf.worker_secrets["ACCESS_CLIENT_SECRET"], ACCESS_CLIENT_SECRET)
        self.assertEqual(sorted(app["domain"] for app in h.cf.apps),
                         ["catalog-origin.dyzzyscards.com", "pricing-origin.dyzzyscards.com"])
        policy = h.cf.policies[0]
        self.assertEqual(policy["decision"], "non_identity")
        self.assertEqual(policy["include"], [{"service_token": {"token_id": h.cf.tokens[0]["id"]}}])
        self.assertTrue(all(app["policies"] == [{"id": policy["id"], "precedence": 1}] for app in h.cf.apps))
        # The Worker holds the Access token before any lock exists.
        order = [e for e in h.events if e[0] == "cloudflare" and e[1] != "GET"]
        secret_put = max(i for i, e in enumerate(order) if e[3] == "ACCESS_CLIENT_SECRET")
        first_lock = min(i for i, e in enumerate(order) if e[2].endswith(("/access/policies", "/access/apps")))
        self.assertLess(secret_put, first_lock)

    def test_service_token_stored_in_bitwarden_before_worker_push(self):
        h = Harness()
        self.assertEqual(h.cutover(), 0, h.stderr)
        created = h.events.index(("cloudflare", "POST", f"{A}/access/service_tokens", "tcg-api-gateway"))
        stored = [i for i, e in enumerate(h.events) if e[0] == "bitwarden.put"]
        pushed = [i for i, e in enumerate(h.events) if e[0] == "cloudflare" and e[1] == "PUT"
                  and e[3] in ("ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET")]
        self.assertEqual(len(stored), 2)
        self.assertTrue(created < min(stored) and max(stored) < min(pushed))
        self.assertEqual(h.store.values["TCG_GATEWAY_ACCESS_CLIENT_SECRET"], ACCESS_CLIENT_SECRET)

    def test_bitwarden_failure_after_token_create_deletes_token(self):
        h = Harness(store_fail_put=True)
        self.assertEqual(h.cutover(), 1)
        self.assertEqual(h.cf.tokens, [])
        self.assertNotIn("ACCESS_CLIENT_ID", h.cf.worker_secrets)
        self.assertEqual(h.cf.apps, [])

    # --- cr:serve-api-mintuition-app-alongside-api (task #11) ---
    def test_plan_mode_lists_both_hostnames(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cutover.main([], open_store=unreachable, open_cloudflare=unreachable,
                         input_fn=unreachable, variables=PRODUCTION_VARS)
        self.assertIn("api.dyzzyscards.com", out.getvalue())
        self.assertIn("api.mintuition.app", out.getvalue())

    def test_mintuition_attached_nowhere_is_attached_in_its_own_zone(self):
        h = Harness()
        self.assertEqual(h.cutover(), 0, h.stderr)
        mint = [d for d in h.cf.domains if d["hostname"] == "api.mintuition.app"]
        self.assertEqual([(d["service"], d["zone_id"]) for d in mint], [("tcg-api-gateway", "zone2")])
        self.assertFalse(any(m == "DELETE" and "/workers/domains/dom2" in p for m, p, _ in h.cf.calls))

    def test_mintuition_on_old_worker_is_moved(self):
        h = Harness(mintuition_service="sourcery-gateway")
        self.assertEqual(h.cutover(), 0, h.stderr)
        self.assertEqual({d["service"] for d in h.cf.domains}, {"tcg-api-gateway"})
        self.assertEqual(len(h.cf.domains), 2)

    def test_mintuition_on_unexpected_worker_stops_before_mutating(self):
        h = Harness(mintuition_service="some-other-worker")
        self.assertEqual(h.cutover(), 1)
        self.assertIn("api.mintuition.app", h.stderr)
        self.assertEqual(h.cf.mutations(), [])

    def test_rerun_after_both_moved_changes_nothing_on_domains(self):
        h = Harness()
        self.assertEqual(h.cutover(), 0, h.stderr)
        before = [c for c in h.cf.mutations() if "/workers/domains" in c[1]]
        h.answers = []
        h.cutover()
        after = [c for c in h.cf.mutations() if "/workers/domains" in c[1]]
        self.assertEqual(before, after)

    def test_route_not_custom_domain_stops(self):
        h = Harness(domain_service=None, route=True)
        self.assertEqual(h.cutover(), 1)
        self.assertIn("zone Worker route", h.stderr)
        self.assertEqual(h.cf.mutations(), [])

    def test_domain_attached_nowhere_is_attached(self):
        # the state an interrupted run leaves api.dyzzyscards.com in (detached, not yet attached)
        h = Harness(domain_service=None)
        self.assertEqual(h.cutover(), 0, h.stderr)
        self.assertEqual(sorted((d["hostname"], d["service"]) for d in h.cf.domains),
                         [("api.dyzzyscards.com", "tcg-api-gateway"), ("api.mintuition.app", "tcg-api-gateway")])

    def test_attach_failure_rolls_back_to_old_worker(self):
        h = Harness(fail={("PUT", f"{A}/workers/domains", "tcg-api-gateway")})
        self.assertEqual(h.cutover(), 1)
        self.assertIn("rolled back", h.stderr)
        self.assertEqual([d["service"] for d in h.cf.domains], ["sourcery-gateway"])
        self.assertEqual(h.cf.tokens, [])

    def test_attach_and_rollback_failure_says_domain_is_detached(self):
        h = Harness(fail={("PUT", f"{A}/workers/domains", "tcg-api-gateway"),
                          ("PUT", f"{A}/workers/domains", "sourcery-gateway")})
        self.assertEqual(h.cutover(), 1)
        self.assertIn("attached to NO Worker", h.stderr)

    def test_g3_phrase_mismatch_mutates_nothing(self):
        h = Harness(answers=["yes"])
        self.assertEqual(h.cutover(), 1)
        self.assertIn("confirmation did not match", h.stderr)
        self.assertEqual(h.cf.mutations(), [])
        self.assertFalse(any(e[0] == "bitwarden.put" for e in h.events))

    def test_g4_phrase_mismatch_creates_no_lock(self):
        h = Harness(answers=[G3, "lock"])
        self.assertEqual(h.cutover(), 1)
        self.assertEqual(sorted((d["hostname"], d["service"]) for d in h.cf.domains),
                         [("api.dyzzyscards.com", "tcg-api-gateway"), ("api.mintuition.app", "tcg-api-gateway")])
        self.assertEqual(h.cf.policies, [])
        self.assertEqual(h.cf.apps, [])

    def test_rerun_skips_done_steps(self):
        h = Harness()
        self.assertEqual(h.cutover(), 0, h.stderr)
        h.cf.calls.clear()
        h.answers, h.prompts = [], 0
        self.assertEqual(h.cutover(), 0, h.stderr)
        self.assertEqual(h.prompts, 0)
        self.assertEqual({(m, p) for m, p, _ in h.cf.mutations()},
                         {("PUT", f"{A}/workers/scripts/tcg-api-gateway/secrets")})  # re-push only
        self.assertEqual(len(h.cf.tokens), 1)
        self.assertEqual(len(h.cf.apps), 2)
        self.assertEqual(len(h.cf.policies), 1)

    def test_existing_token_without_bitwarden_halves_stops(self):
        h = Harness(domain_service="tcg-api-gateway")
        h.cf.tokens.append({"id": "t0", "name": "tcg-api-gateway", "client_id": ACCESS_CLIENT_ID,
                            "client_secret": ACCESS_CLIENT_SECRET})
        self.assertEqual(h.cutover(), 1)
        self.assertIn("cannot be read again", h.stderr)
        self.assertEqual(len(h.cf.tokens), 1)
        self.assertNotIn("ACCESS_CLIENT_ID", h.cf.worker_secrets)

    def test_preflight_mode_only_reads(self):
        h = Harness()
        self.assertEqual(h.cutover(argv=["--preflight"]), 0, h.stderr)
        self.assertEqual(h.cf.mutations(), [])


class CreateAppKeyTests(unittest.TestCase):
    NAME = "TCG_GATEWAY_APP_KEY_POKE_GUIDE_DEV"

    def run_tool(self, argv, store):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = create_app_key.main(argv, open_store=lambda: store)
        return code, out.getvalue(), err.getvalue()

    def test_plan_mode_contacts_nothing(self):
        store = FakeStore([], values={})
        code, out, _ = self.run_tool(["POKE_GUIDE_DEV"], store)
        self.assertEqual((code, store.events, store.values), (0, [], {}))
        self.assertIn(self.NAME, out)

    def test_apply_stores_the_key_and_prints_only_its_hash(self):
        store = FakeStore([], values={})
        code, out, err = self.run_tool(["POKE_GUIDE_DEV", "--apply"], store)
        key = store.values[self.NAME]
        self.assertEqual((code, store.events), (0, [("bitwarden.put", self.NAME)]))
        self.assertRegex(key, r"^[0-9a-f]{64}$")
        self.assertIn("keySha256 " + create_app_key.key_sha256(key), out)
        self.assertNotIn(key, out + err)

    def test_existing_key_is_kept_unless_rotate(self):
        store = FakeStore([], values={self.NAME: "old-key-never-print-0008"})
        code, out, err = self.run_tool(["POKE_GUIDE_DEV", "--apply"], store)
        self.assertEqual((code, store.events, store.values[self.NAME]), (1, [], "old-key-never-print-0008"))
        self.assertNotIn("old-key-never-print-0008", out + err)
        code, _, _ = self.run_tool(["POKE_GUIDE_DEV", "--apply", "--rotate"], store)
        self.assertEqual(code, 0)
        self.assertNotEqual(store.values[self.NAME], "old-key-never-print-0008")

    def test_bad_app_name_and_store_failure(self):
        store = FakeStore([], values={})
        self.assertEqual(self.run_tool(["poke guide"], store)[0], 2)
        failing = FakeStore([], values={}, fail_put=True)
        self.assertEqual(self.run_tool(["POKE_GUIDE_DEV", "--apply"], failing)[0], 1)
        self.assertEqual(failing.values, {})


class SecretSweepTests(unittest.TestCase):
    def test_no_secret_value_in_any_output(self):
        runs = [
            lambda h: h.cutover(),
            lambda h: h.cutover(),  # re-run on the same harness below
            lambda h: h.push(["--apply"]),
            lambda h: h.push(["--generate-session-key", "--apply"]),
        ]
        harnesses = [Harness(), Harness(fail={("PUT", f"{A}/workers/domains", "tcg-api-gateway")}),
                     Harness(store_fail_put=True), Harness(answers=["nope"]), Harness(domain_service=None, route=True)]
        for h in harnesses:
            for run in runs:
                run(h)
            output = h.stdout + h.stderr
            self.assertTrue(output)
            for value in h.secret_values():
                if value:
                    self.assertNotIn(value, output)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
