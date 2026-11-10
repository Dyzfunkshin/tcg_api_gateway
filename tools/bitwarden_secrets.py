"""Read gateway secrets from Bitwarden Secrets Manager without printing them.

Operator tooling (PLAN.md section 7): runs on the owner's PC as the narrow
`gateway-deploy` machine account (read on projects api-gateway and hosted-api; write on
api-gateway only while the owner grants it for a G3 cut-over or a key rotation). Its token
lives in Windows Credential Manager under `gateway-deploy/bitwarden-machine-token` and is read with the catalog repo's
`tools/machine_token.py` (never copied here). Needs the `bitwarden-sdk` package,
which the Worker itself never uses; install it in a throwaway venv.

Values are returned to the caller only; nothing here prints or logs a value.
"""

import pathlib
import sys

BITWARDEN_ORG_ID = "fb861205-eddd-488f-a18c-b4fd0066477a"
MACHINE_TOKEN_TARGET = "gateway-deploy/bitwarden-machine-token"
MACHINE_TOKEN_TOOLS = pathlib.Path(__file__).resolve().parents[2] / "tcg_catalog_service" / "tools"


def machine_account_token() -> str:
    """The gateway-deploy machine token from Credential Manager, or exit with a hint."""
    sys.path.insert(0, str(MACHINE_TOKEN_TOOLS))
    try:
        import machine_token  # noqa: PLC0415 (sibling repo's helper, path set above)
    finally:
        sys.path.pop(0)
    try:
        token, _source = machine_token.read_machine_token(target=MACHINE_TOKEN_TARGET)
    except machine_token.MachineTokenError as error:
        sys.exit(f"gateway-deploy machine token unavailable: {error}")
    return token


def bitwarden_client():
    """A logged-in Bitwarden SDK client for gateway-deploy."""
    from bitwarden_sdk import BitwardenClient, DeviceType, client_settings_from_dict  # noqa: PLC0415

    client = BitwardenClient(client_settings_from_dict({
        "apiUrl": "https://api.bitwarden.com",
        "identityUrl": "https://identity.bitwarden.com",
        "deviceType": DeviceType.SDK,
        "userAgent": "tcg-api-gateway-ops",
    }))
    login = client.auth().login_access_token(machine_account_token(), state_file=None)
    if not (login.success and login.data and login.data.authenticated):
        sys.exit("Bitwarden login failed for gateway-deploy")
    return client


def secret_value(client, key: str) -> str:
    """The value of the secret named `key` in the organization; exits if absent or ambiguous."""
    listing = client.secrets().list(BITWARDEN_ORG_ID)
    if not (listing.success and listing.data):
        sys.exit("could not list Bitwarden secrets")
    matches = [s for s in listing.data.data if s.key == key]
    if len(matches) != 1:
        sys.exit(f"expected exactly one Bitwarden secret named {key}, found {len(matches)}")
    found = client.secrets().get(str(matches[0].id))
    if not (found.success and found.data and found.data.value):
        sys.exit(f"secret {key} is unreadable")
    return found.data.value
