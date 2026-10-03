"""Private scanning gateway. Streams bytes to clamd; never writes uploads to disk."""
import datetime
import hashlib
import hmac
import json
import os
import re
import socket
import struct
import time

MAX_BYTES = 10 * 1024 * 1024
MAX_SIGNATURE_AGE = 72 * 3600
MIN_ENGINE = (1, 5, 4)


class ScannerUnavailable(Exception):
    pass


def receive(connection):
    result = bytearray()
    while len(result) <= 4096:
        chunk = connection.recv(4096)
        if not chunk:
            raise ScannerUnavailable()
        result.extend(chunk)
        if b'\0' in result:
            return bytes(result).split(b'\0', 1)[0].decode('ascii', errors='strict')
    raise ScannerUnavailable()


def connect():
    return socket.create_connection((os.environ.get('CLAMD_HOST', 'clamav'), int(os.environ.get('CLAMD_PORT', '3310'))), timeout=25)


def engine_status(now=None):
    with connect() as connection:
        connection.sendall(b'zVERSION\0')
        version = receive(connection)
    match = re.fullmatch(r'ClamAV (\d+\.\d+\.\d+)/(\d+)/(.+)', version)
    if not match or tuple(map(int, match[1].split('.'))) < MIN_ENGINE or int(match[2]) < 1:
        raise ScannerUnavailable()
    timestamp = int(datetime.datetime.strptime(match[3], '%a %b %d %H:%M:%S %Y').replace(tzinfo=datetime.timezone.utc).timestamp())
    age = (time.time() if now is None else now) - timestamp
    if age < -300 or age > MAX_SIGNATURE_AGE:
        raise ScannerUnavailable()
    return {'engineVersion': match[1], 'signatureVersion': int(match[2]), 'signatureTimestamp': timestamp}


def scan(payload):
    status = engine_status()
    with connect() as connection:
        connection.sendall(b'zINSTREAM\0')
        for offset in range(0, len(payload), 64 * 1024):
            chunk = payload[offset:offset + 64 * 1024]
            connection.sendall(struct.pack('!I', len(chunk)) + chunk)
        connection.sendall(struct.pack('!I', 0))
        reply = receive(connection)
    # Error/limit/malformed responses never count as clean. Encrypted documents,
    # archive limits, and Office macros are configured to produce FOUND as well.
    if reply == 'stream: OK':
        verdict = 'clean'
    elif re.fullmatch(r'stream: .+ FOUND', reply):
        verdict = 'blocked'
    else:
        raise ScannerUnavailable()
    return {**status, 'verdict': verdict, 'sha256': hashlib.sha256(payload).hexdigest(), 'scannedBytes': len(payload)}


def configured_token():
    with open(os.environ.get('SCANNER_TOKEN_FILE', '/run/secrets/scanner_token'), encoding='ascii') as source:
        token = source.read().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ScannerUnavailable()
    return token


def application(environ, start_response):
    def respond(status, data):
        body = json.dumps(data, separators=(',', ':')).encode('ascii')
        start_response(status, [('Content-Type', 'application/json'), ('Content-Length', str(len(body))), ('Cache-Control', 'no-store')])
        return [body]

    try:
        token = configured_token()
        authorization = environ.get('HTTP_AUTHORIZATION', '')
        if not hmac.compare_digest(authorization.encode('utf-8'), ('Bearer ' + token).encode('ascii')):
            return respond('401 Unauthorized', {'error': 'Unauthorized'})
        path, method = environ.get('PATH_INFO'), environ.get('REQUEST_METHOD')
        if path == '/health' and method == 'GET':
            return respond('200 OK', {'ok': True, **engine_status()})
        if path != '/scan' or method != 'POST':
            return respond('404 Not Found', {'error': 'Not found'})
        raw_length = environ.get('CONTENT_LENGTH', '')
        if not re.fullmatch(r'[0-9]{1,8}', raw_length):
            return respond('411 Length Required', {'error': 'Length required'})
        length = int(raw_length)
        if not 1 <= length <= MAX_BYTES:
            return respond('413 Content Too Large', {'error': 'Invalid document size'})
        if environ.get('CONTENT_TYPE') != 'application/octet-stream':
            return respond('415 Unsupported Media Type', {'error': 'Unsupported media type'})
        expected_hash = environ.get('HTTP_X_DOCUMENT_SHA256', '')
        if not re.fullmatch(r'[a-f0-9]{64}', expected_hash):
            return respond('400 Bad Request', {'error': 'Digest required'})
        payload = bytearray()
        while len(payload) < length:
            chunk = environ['wsgi.input'].read(min(64 * 1024, length - len(payload)))
            if not chunk:
                return respond('400 Bad Request', {'error': 'Incomplete document'})
            payload.extend(chunk)
        if not hmac.compare_digest(hashlib.sha256(payload).hexdigest(), expected_hash):
            return respond('400 Bad Request', {'error': 'Digest mismatch'})
        return respond('200 OK', scan(payload))
    except Exception:
        # No request metadata or raw ClamAV errors in logs or responses.
        return respond('503 Service Unavailable', {'error': 'Scanner unavailable'})
