"""Check a deployed private scanner using synthetic bytes only; never print secrets."""
import argparse
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='HTTPS scanner origin, without /scan')
    parser.add_argument('--token-file', default='secrets/scanner-token')
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.url)
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ['', '/']:
        parser.error('Use an HTTPS origin without credentials, query, or path')
    token = Path(args.token_file).read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        parser.error('The token file must contain 64 lowercase hexadecimal characters')
    opener = urllib.request.build_opener(NoRedirects())

    def request(route, payload=None, auth=token):
        headers = {'Authorization': 'Bearer ' + auth}
        if payload is not None:
            headers.update({'Content-Type': 'application/octet-stream', 'X-Document-SHA256': hashlib.sha256(payload).hexdigest()})
        req = urllib.request.Request(args.url.rstrip('/') + route, data=payload, headers=headers)
        try:
            response = opener.open(req, timeout=35)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(8193)
            if len(body) > 8192:
                raise RuntimeError('Oversized scanner response')
            return response.status, json.loads(body)

    def metadata(report):
        version = report.get('engineVersion', '')
        assert re.fullmatch(r'\d+\.\d+\.\d+', version) and tuple(map(int, version.split('.'))) >= (1, 5, 4)
        assert isinstance(report.get('signatureVersion'), int) and report['signatureVersion'] > 0
        assert isinstance(report.get('signatureTimestamp'), int) and -300 <= time.time() - report['signatureTimestamp'] <= 72 * 3600

    status, _ = request('/health', auth='0' * 64 if token != '0' * 64 else '1' * 64)
    assert status == 401, 'An invalid token must be rejected'
    print('PASS: invalid token rejected')
    status, report = request('/health')
    assert status == 200 and report.get('ok') is True, 'Scanner health failed'
    metadata(report)
    print('PASS: engine and signature freshness')
    cases = [(b'Top-tier Patent Search synthetic scanner check', 'clean'),
             (b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'blocked')]
    for payload, expected in cases:
        status, report = request('/scan', payload)
        assert status == 200 and report.get('verdict') == expected, 'Unexpected scan verdict'
        assert report.get('sha256') == hashlib.sha256(payload).hexdigest() and report.get('scannedBytes') == len(payload)
        metadata(report)
        print('PASS: synthetic ' + expected + ' verdict matches the submitted bytes')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('FAIL: scanner readiness check failed; do not activate document downloads')
