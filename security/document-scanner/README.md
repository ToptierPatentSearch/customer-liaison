# Private document scanning for Top-tier Patent Search

**Prepared for Section 8; not activated in production.** A private HTTPS scanner must pass the readiness checks below before deploying the changed download functions. Deploying them without a working scanner blocks every application document download. No database migration is required.

## Download policy

Every original order/quote document and workspace document is scanned on each authorized download request. The application verifies ownership and client visibility, or administrator membership and MFA, before obtaining any bytes. It sends only those bytes and their SHA-256 digest to this private server. A download link is issued only after a clean result matches the exact digest and byte count, an engine version of at least 1.5.4, and signatures no more than 72 hours old. Links expire after 60 seconds. Existing private documents use the same checks automatically; there is no unverified "clean" backfill.

Detected malware, encrypted documents/archives, Office macros, and exceeded scanning limits are blocked. Scanner errors, timeouts, stale definitions, unsupported engines, and malformed reports deny downloads. Files remain private in Storage; they are not automatically deleted. Request an unencrypted, malware-free replacement. There is no unscanned bypass, public reputation lookup, or public document submission.

The scanned object must remain immutable through the signed link's lifetime. Application uploads use unique paths and `upsert: false`, and browser roles have no Storage UPDATE/DELETE access. Preserve those restrictions. Administrators using the Storage dashboard or a service-role key must also upload replacements under a new path, never overwrite an existing object. A privileged overwrite between scanning and download would invalidate the byte guarantee. Signed links are bearer credentials: recipients must not forward them.

## Host prerequisites

Use a dedicated, privately administered Linux host with Docker Engine and the Compose plugin, a DNS hostname pointing to it, and at least 8 GB RAM and two CPUs. The configuration reserves up to 4 GB for ClamAV plus capacity for the gateway, HTTPS proxy, and operating system. Hosting and domain costs depend on the selected provider; this repository does not provision or purchase them.

Only ports 80 and 443 are published. Restrict SSH to the administrator's approved network. Never expose ClamAV port 3310 or gateway port 8080 to the host or Internet. ClamAV's TCP protocol has no authentication or encryption; Docker's private service network isolates that connection. Use a host without other untrusted containers or users. Where practical, restrict HTTPS source access to the application's server egress, retaining access for readiness checks. Do not open 3310 as a workaround.

ClamAV downloads antivirus definitions from its official mirrors. It does not submit uploaded documents to them. Uploads are passed in memory; ClamAV's temporary extraction directory is a bounded RAM filesystem. Gunicorn request access logging is disabled, and Caddy access logging is not enabled. Avoid enabling request/body/header logging on upstream infrastructure. Disable host swap or use encrypted swap, restrict diagnostic dumps, and apply the organization's confidential-data retention policy to the host and backups.

The official ClamAV, Python, and Caddy image digests and Gunicorn wheel hash are pinned for reproducible deployment. Keep the persisted signatures volume: rebuilding it on every restart can exhaust antivirus mirror quotas.

## Start the scanner

Check out this reviewed change on the host, then change into `security/document-scanner`. The following creates a fresh server token without printing it:

```sh
python3 - <<'PY'
import os, secrets
from pathlib import Path
directory = Path('secrets')
directory.mkdir(mode=0o700, exist_ok=True)
os.chmod(directory, 0o700)
token = directory / 'scanner-token'
with token.open('x', encoding='ascii') as destination:
    destination.write(secrets.token_hex(32) + '\n')
os.chmod(token, 0o444)
PY
```

The containing directory is accessible only to its owner; the file is readable by gateway UID 10001 when Docker mounts it as a secret. Do not add the file to version control, print it into deployment logs, or put it in a URL, browser variable, command argument, or chat message. The script refuses to overwrite an existing token. Copy its value privately into Supabase's server-side secret editor during activation.

Create `.env` with the hostname only:

```dotenv
SCANNER_HOSTNAME=scanner.example.com
```

Replace the example with the actual hostname. DNS must already resolve to the host; Caddy obtains and renews its HTTPS certificate through ports 80/443. Then run:

```sh
docker compose config --quiet
docker compose up --build -d
python3 smoke_test.py --url https://scanner.example.com
```

Wait for the initial FreshClam definition download and engine startup before repeating the readiness check. The script checks invalid-token rejection, current engine/signature metadata, a synthetic clean payload, and the harmless EICAR antivirus test string. It never opens customer documents and prints no token. All four checks must pass. A test string may trigger antivirus on the operator's own computer; it contains no executable malware.

Keep the host's clock synchronized. Do not alter the freshness threshold or disable encrypted-document, macro, or scan-limit detection merely to pass readiness. Check container status and engine startup errors locally without collecting upload bodies or authentication headers.

## Activate application protection

1. Complete the HTTPS readiness test against the final hostname. Confirm the host's confidentiality and access controls and preserve the immutable-object policy above.
2. In Supabase project `syshvcymwktnkrkrvwtk`, set server-side Edge Function secrets `DOCUMENT_SCANNER_URL=https://<actual-hostname>/scan` and `DOCUMENT_SCANNER_TOKEN=<contents of the private token file>`. These are not `VITE_` variables. Do not put the token in GitHub Pages or the repository.
3. Merge the reviewed application change and allow the frontend validation/deployment to finish. Its error handling displays blocked-document and temporary-scanner messages.
4. Deploy `admin-orders` and `my-requests` from this revision, bundling `_shared/document-scan.ts` and `_shared/rate-limit.ts`. Preserve their authenticated `withSupabase({ auth: 'user' })` wrappers and existing gateway JWT settings. No other function needs a Section 8 deployment.
5. Use dedicated test accounts and synthetic files to verify original order and quote downloads and workspace downloads, for both a permitted client and an MFA-verified administrator. Confirm another account cannot request the file. Use EICAR to confirm HTTP 422 `DOCUMENT_BLOCKED`; briefly stop the scanner to confirm HTTP 503 `DOCUMENT_SCAN_UNAVAILABLE` without a signed URL, then restore and retest. Do not use real invention documents for commissioning.

Previously issued links may remain usable until their original expiry; wait for that expiry before declaring protection fully active. New links expire after 60 seconds. Store a deployment record with the tested application revision and scanner image digests, without tokens or client filenames.

## Maintenance and recovery

FreshClam runs in the official container and updates the persisted definition database. The engine reloads updated definitions; health and every download enforce the 72-hour freshness limit. Monitor authenticated health from trusted infrastructure without recording its Authorization header. Use synthetic readiness checks after patches or network changes. ClamAV reduces risk but cannot establish that every clean document is harmless; retain endpoint antivirus and safe document handling on administrator computers.

Review official security updates and replace pinned images and hashes in a reviewed change. Test newer versions before rollout; the current minimum is 1.5.4. Maintain backups of configuration and TLS state according to the organization's policy; no upload files need scanner backups. Rotate a token by replacing the host secret file, restarting the gateway, updating the Supabase server secret privately, and rerunning readiness. The short mismatch window intentionally denies downloads.

If the host or signatures fail, restore the private service and run readiness. Do not redeploy older unscanned download functions, expose ClamAV directly, remove checking, or mark files clean manually to restore availability.

## Verification in this change

`npm test` covers all six download actions, authorization before scanning, clean versus blocked results, byte matching, stale signatures, unsupported engines, network errors, configuration errors, and bounded file/report sizes. The standard-library gateway tests run in CI:

```sh
python3 -m unittest discover -s security/document-scanner -p 'test_*.py'
```

An optional test starts a real ClamAV binary and verifies this configuration and the INSTREAM protocol with a dedicated EICAR test signature:

```sh
CLAMD_TEST_BINARY=/path/to/clamd python3 -m unittest discover -s security/document-scanner -p 'test_*.py'
```

That local test deliberately substitutes engine metadata because its test-only database has no official definition header. Metadata/freshness enforcement is covered separately. The real ClamAV 1.5.4 test passed during preparation with `CLAMD_TEST_TCP_ONLY=1`: the workspace prohibits Unix sockets, so the test omitted the local startup socket while retaining the TCP interface and scanning options. Production retains that local socket, which the official container entrypoint needs. Docker is unavailable in the preparation workspace, so the complete three-container deployment, official definition update, TLS issuance, and live account workflow remain host commissioning checks, not claimed successes.

References: [ClamAV Docker deployment and memory requirements](https://docs.clamav.net/manual/Installing/Docker.html), [ClamAV protocol and INSTREAM](https://docs.clamav.net/manual/Usage/ClamdProtocol.html), [official engine releases](https://www.clamav.net/downloads).
