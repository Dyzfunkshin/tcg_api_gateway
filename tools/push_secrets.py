"""Push the gateway's Worker secrets from Bitwarden to Cloudflare (PLAN.md section 7).

Usage (from a venv with bitwarden-sdk, as owner via owner-ops):
  python tools/push_secrets.py                         # print the plan; contacts nothing
  python tools/push_secrets.py --apply                 # push every secret in the table
  python tools/push_secrets.py --only PRICING_APP_TOKEN --apply
  python tools/push_secrets.py --generate-session-key --apply   # PLAN.md 7.1 rotation

Each secret is read from Bitwarden and written with
PUT /accounts/{account}/workers/scripts/tcg-api-gateway/secrets. Only secret
NAMES are printed; values never reach output, logs or exceptions. A secret
missing from Bitwarden is reported by name and not pushed; the run then exits 1.
"""

import argparse
import secrets
import sys

from cloudflare_api import ACCOUNT_ID, CLOUDFLARE_TOKEN_KEY, WORKER_NAME, CloudflareClient, CloudflareError

# Worker secret -> Bitwarden secret key (PLAN.md section 7 table), in push order.
WORKER_SECRETS = {
    "PRICING_APP_TOKEN": "PRICING_APP_TOKEN",
    "CATALOG_APP_TOKEN": "CATALOG_APP_TOKEN",
    "ACCESS_CLIENT_ID": "TCG_GATEWAY_ACCESS_CLIENT_ID",
    "ACCESS_CLIENT_SECRET": "TCG_GATEWAY_ACCESS_CLIENT_SECRET",
    "TURNSTILE_SECRET_KEY": "TCG_GATEWAY_TURNSTILE_SECRET",
    "SESSION_SIGNING_KEY": "TCG_GATEWAY_SESSION_SIGNING_KEY",
}
# Set both or neither: one alone makes every forward a 503 (src/worker.js accessHeaders).
ACCESS_PAIR = ("ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET")
API_GATEWAY_PROJECT_ID = "a24de797-21ea-4454-b0a9-b4fd0070fc4a"
SESSION_KEY_BYTES = 32
SECRETS_PATH = f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}/secrets"


class SecretStoreError(Exception):
    """A Bitwarden failure; the message names the key, never a value."""


class BitwardenStore:
    """Bitwarden Secrets Manager by secret key, over a logged-in bitwarden_sdk client."""

    def __init__(self, client, organization_id=None):
        if organization_id is None:
            from bitwarden_secrets import BITWARDEN_ORG_ID  # noqa: PLC0415
            organization_id = BITWARDEN_ORG_ID
        self._client = client
        self._organization_id = organization_id

    def _ids(self, key: str) -> list[str]:
        listing = self._client.secrets().list(self._organization_id)
        if not (listing.success and listing.data):
            raise SecretStoreError("could not list Bitwarden secrets")
        return [str(s.id) for s in listing.data.data if s.key == key]

    def get(self, key: str):
        """The value of `key`, or None if no such secret exists."""
        ids = self._ids(key)
        if not ids:
            return None
        if len(ids) > 1:
            raise SecretStoreError(f"{len(ids)} Bitwarden secrets are named {key}; expected one")
        found = self._client.secrets().get(ids[0])
        if not (found.success and found.data and found.data.value):
            raise SecretStoreError(f"Bitwarden secret {key} is unreadable")
        return found.data.value

    def put(self, key: str, value: str, project_id: str, note: str) -> None:
        """Create `key`, or replace its value if it already exists."""
        ids = self._ids(key)
        if len(ids) > 1:
            raise SecretStoreError(f"{len(ids)} Bitwarden secrets are named {key}; expected one")
        api = self._client.secrets()
        if ids:
            response = api.update(organization_id=self._organization_id, id=ids[0], key=key,
                                  value=value, note=note, project_ids=[project_id])
        else:
            response = api.create(organization_id=self._organization_id, key=key,
                                  value=value, note=note, project_ids=[project_id])
        if not response.success:
            raise SecretStoreError(f"could not store Bitwarden secret {key}")


def open_bitwarden_store() -> BitwardenStore:
    from bitwarden_secrets import bitwarden_client  # noqa: PLC0415 (needs bitwarden-sdk)
    return BitwardenStore(bitwarden_client())


def open_cloudflare(store) -> CloudflareClient:
    token = store.get(CLOUDFLARE_TOKEN_KEY)
    if not token:
        raise SecretStoreError(f"Bitwarden secret {CLOUDFLARE_TOKEN_KEY} not found")
    return CloudflareClient(token)


def worker_secret_names(cloudflare) -> set[str]:
    return {s.get("name") for s in cloudflare.get(SECRETS_PATH) or []}


def put_worker_secret(cloudflare, name: str, value: str) -> None:
    cloudflare.put(SECRETS_PATH, {"name": name, "text": value, "type": "secret_text"})
    print(f"pushed   {name}")


def push(cloudflare, store, names) -> list[str]:
    """Push each Worker secret in `names` from Bitwarden; returns the names NOT pushed.

    The Access pair goes together: if either half is missing from Bitwarden neither is
    pushed, and if the second push fails a first half that the Worker did not hold
    before is deleted again, so the Worker never runs with one half alone.
    """
    values, failed = {}, []
    for name in names:
        key = WORKER_SECRETS[name]
        try:
            value = store.get(key)
        except SecretStoreError as error:
            print(f"error    {name}: {error}; not pushed", file=sys.stderr)
            failed.append(name)
            continue
        if not value:
            print(f"missing  {name}: Bitwarden secret {key} not found; not pushed", file=sys.stderr)
            failed.append(name)
            continue
        values[name] = value

    pair = [n for n in ACCESS_PAIR if n in names]
    if pair and len([n for n in ACCESS_PAIR if n in values]) != 2:
        for name in pair:
            if name in values:
                del values[name]
                failed.append(name)
                print(f"skipped  {name}: the Access pair is pushed together or not at all", file=sys.stderr)

    held_before = worker_secret_names(cloudflare) if all(n in values for n in ACCESS_PAIR) else set()
    for name in names:
        if name not in values:
            continue
        try:
            put_worker_secret(cloudflare, name, values[name])
        except CloudflareError as error:
            print(f"error    {name}: {error}", file=sys.stderr)
            failed.append(name)
            if name == ACCESS_PAIR[1] and ACCESS_PAIR[0] not in failed and ACCESS_PAIR[0] not in held_before:
                cloudflare.delete(f"{SECRETS_PATH}/{ACCESS_PAIR[0]}")
                print(f"removed  {ACCESS_PAIR[0]} again (its pair failed)", file=sys.stderr)
            elif name == ACCESS_PAIR[1] and ACCESS_PAIR[0] not in failed:
                print(f"WARNING  {ACCESS_PAIR[0]} was replaced but {name} was not; re-run both", file=sys.stderr)
    return failed


def generate_session_key(store) -> None:
    """Store a fresh random SESSION_SIGNING_KEY in Bitwarden (PLAN.md 7.1). Never displayed."""
    key = WORKER_SECRETS["SESSION_SIGNING_KEY"]
    store.put(key, secrets.token_urlsafe(SESSION_KEY_BYTES), API_GATEWAY_PROJECT_ID,
              "Gateway public-session HMAC key; generated by tools/push_secrets.py (PLAN.md 7.1)")
    print(f"stored   {key} (new random value, {SESSION_KEY_BYTES} bytes) in Bitwarden project api-gateway")


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Push gateway Worker secrets from Bitwarden.")
    parser.add_argument("--only", action="append", choices=list(WORKER_SECRETS), metavar="NAME",
                        help="push only this Worker secret (repeatable)")
    parser.add_argument("--generate-session-key", action="store_true",
                        help="generate and store a new SESSION_SIGNING_KEY in Bitwarden, then push it")
    parser.add_argument("--apply", action="store_true", help="perform the push (default: print the plan)")
    return parser.parse_args(argv)


def selected_names(args) -> list[str]:
    chosen = set(args.only or [])
    if args.generate_session_key:
        chosen.add("SESSION_SIGNING_KEY")
    return [n for n in WORKER_SECRETS if not chosen or n in chosen]


def main(argv=None, *, open_store=open_bitwarden_store, open_cloudflare=open_cloudflare) -> int:
    args = parse_args(argv)
    names = selected_names(args)
    if not args.apply:
        print("plan (nothing contacted; add --apply to perform):")
        if args.generate_session_key:
            print(f"  generate {SESSION_KEY_BYTES} random bytes -> Bitwarden {WORKER_SECRETS['SESSION_SIGNING_KEY']}"
                  f" (project api-gateway {API_GATEWAY_PROJECT_ID}), replacing any old value")
        for name in names:
            print(f"  PUT {SECRETS_PATH}  {name} <- Bitwarden {WORKER_SECRETS[name]}")
        return 0
    try:
        store = open_store()
        if args.generate_session_key:
            generate_session_key(store)
        cloudflare = open_cloudflare(store)
        failed = push(cloudflare, store, names)
    except (SecretStoreError, CloudflareError) as error:
        print(f"stopped: {error}", file=sys.stderr)
        return 1
    print("all pushed" if not failed else f"not pushed: {', '.join(failed)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
