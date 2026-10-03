import contextlib
import hashlib
import io
import os
import socket
import struct
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import gateway

TOKEN = 'a' * 64
PAYLOAD = b'Example confidential document'


def request(payload=PAYLOAD, **changes):
    environ = {'REQUEST_METHOD': 'POST', 'PATH_INFO': '/scan', 'HTTP_AUTHORIZATION': 'Bearer ' + TOKEN,
               'CONTENT_LENGTH': str(len(payload)), 'CONTENT_TYPE': 'application/octet-stream',
               'HTTP_X_DOCUMENT_SHA256': hashlib.sha256(payload).hexdigest(), 'wsgi.input': io.BytesIO(payload)}
    environ.update(changes)
    result = {}
    def start(status, headers):
        result.update(status=status, headers=dict(headers))
    result['body'] = b''.join(gateway.application(environ, start))
    return result


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.token = patch.object(gateway, 'configured_token', return_value=TOKEN)
        self.token.start()
        self.addCleanup(self.token.stop)

    def test_unauthorized_requests_never_read_uploads_or_contact_the_engine(self):
        with patch.object(gateway, 'scan') as scan:
            for authorization in ['', 'Bearer wrong', 'Bearer 日本語']:
                data = request(HTTP_AUTHORIZATION=authorization, **{'wsgi.input': None})
                self.assertEqual(data['status'], '401 Unauthorized')
            scan.assert_not_called()

    def test_size_media_type_digest_and_body_completeness_are_required(self):
        with patch.object(gateway, 'scan') as scan:
            cases = [({'CONTENT_LENGTH': ''}, '411'), ({'CONTENT_LENGTH': '10485761'}, '413'),
                     ({'CONTENT_LENGTH': '0'}, '413'), ({'CONTENT_TYPE': 'text/plain'}, '415'),
                     ({'HTTP_X_DOCUMENT_SHA256': 'wrong'}, '400'),
                     ({'HTTP_X_DOCUMENT_SHA256': 'b' * 64}, '400'),
                     ({'CONTENT_LENGTH': str(len(PAYLOAD) + 1)}, '400')]
            for changes, status in cases:
                self.assertTrue(request(**changes)['status'].startswith(status))
            scan.assert_not_called()

    def test_clean_and_blocked_reports_bind_to_exact_received_bytes(self):
        for verdict in ['clean', 'blocked']:
            with patch.object(gateway, 'scan', side_effect=lambda content: {'verdict': verdict, 'sha256': hashlib.sha256(content).hexdigest(), 'scannedBytes': len(content)}) as scanner:
                data = request()
                self.assertEqual(data['status'], '200 OK')
                scanner.assert_called_once_with(bytearray(PAYLOAD))
                self.assertIn(verdict.encode(), data['body'])

    def test_engine_failures_are_generic_and_reveal_no_details(self):
        with patch.object(gateway, 'scan', side_effect=RuntimeError('secret filename, token and internal address')):
            result = request()
            self.assertEqual(result['status'], '503 Service Unavailable')
            self.assertNotIn(b'secret', result['body'])
            self.assertEqual(result['headers']['Cache-Control'], 'no-store')

    def test_only_authenticated_health_and_scan_routes_are_available(self):
        with patch.object(gateway, 'engine_status', return_value={'engineVersion': '1.5.4'}):
            self.assertEqual(request(REQUEST_METHOD='GET', PATH_INFO='/health')['status'], '200 OK')
            self.assertEqual(request(REQUEST_METHOD='GET')['status'], '404 Not Found')
            self.assertEqual(request(PATH_INFO='/other')['status'], '404 Not Found')

    def test_signature_freshness_and_engine_minimum_are_checked(self):
        now = 1790992800
        with patch.object(gateway, 'connect') as connect, patch.object(gateway, 'receive') as receive:
            for reply in ['ClamAV 1.5.3/1000/Sat Oct 3 03:20:00 2026', 'ClamAV 1.5.4', 'garbage',
                          'ClamAV 1.5.4/1000/Sat Sep 26 03:20:00 2026', 'ClamAV 1.5.4/1000/Sun Oct 4 03:20:00 2026']:
                receive.return_value = reply
                with self.assertRaises((gateway.ScannerUnavailable, ValueError)):
                    gateway.engine_status(now=now)
            receive.return_value = 'ClamAV 1.5.4/1000/Sat Oct 3 02:00:00 2026'
            self.assertEqual(gateway.engine_status(now=now)['signatureVersion'], 1000)

    def test_clamd_stream_wire_framing_and_all_reply_verdicts(self):
        status = {'engineVersion': '1.5.4', 'signatureVersion': 1000, 'signatureTimestamp': int(time.time())}
        with patch.object(gateway, 'engine_status', return_value=status), patch.object(gateway, 'connect') as connect:
            connection = connect.return_value.__enter__.return_value
            for reply, expected in [('stream: OK', 'clean'), ('stream: Eicar-Signature FOUND', 'blocked'), ('stream: Heuristics.Limits.Exceeded FOUND', 'blocked'), ('stream: Heuristics.Encrypted.PDF FOUND', 'blocked')]:
                connection.reset_mock()
                with patch.object(gateway, 'receive', return_value=reply):
                    self.assertEqual(gateway.scan(PAYLOAD)['verdict'], expected)
                actual = b''.join(call.args[0] for call in connection.sendall.call_args_list)
                self.assertEqual(actual, b'zINSTREAM\0' + struct.pack('!I', len(PAYLOAD)) + PAYLOAD + b'\0' * 4)
            for reply in ['stream: scan failed ERROR', 'INSTREAM size limit exceeded', 'OK', 'stream: OK extra']:
                with patch.object(gateway, 'receive', return_value=reply), self.assertRaises(gateway.ScannerUnavailable):
                    gateway.scan(PAYLOAD)

    def test_incomplete_or_unbounded_clamd_replies_are_rejected(self):
        with patch.object(gateway, 'connect') as connect:
            connection = connect.return_value
            for chunk in [b'', b'x' * 5000]:
                connection.recv.return_value = chunk
                with self.assertRaises(gateway.ScannerUnavailable): gateway.receive(connection)


@unittest.skipUnless(os.environ.get('CLAMD_TEST_BINARY'), 'Set CLAMD_TEST_BINARY for the real ClamAV smoke test')
class ActualClamAVTests(unittest.TestCase):
    def test_real_engine_accepts_config_and_detects_harmless_eicar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / 'database'; db.mkdir()
            # Dedicated test signatures only; production must load FreshClam databases.
            (db / 'test.hdb').write_text('44d88612fea8a8f36de82e1278abb02f:68:Local.Eicar.Test\n')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
            config = Path(__file__).with_name('clamd.conf').read_text().replace('User clamav\n', '')
            config = config.replace('DatabaseDirectory /var/lib/clamav', 'DatabaseDirectory ' + str(db)).replace('TCPAddr 0.0.0.0', 'TCPAddr 127.0.0.1').replace('TCPSocket 3310', 'TCPSocket ' + str(port))
            config = config.replace('LocalSocket /tmp/clamd.sock', 'LocalSocket ' + str(root / 'clamd.sock'))
            if os.environ.get('CLAMD_TEST_TCP_ONLY') == '1':
                # Some preparation sandboxes prohibit AF_UNIX even though TCP
                # is available. Production retains the official startup socket.
                config = '\n'.join(line for line in config.splitlines() if not line.startswith('LocalSocket')) + '\n'
            (root / 'clamd.conf').write_text(config)
            process = subprocess.Popen([os.environ['CLAMD_TEST_BINARY'], '--config-file=' + str(root / 'clamd.conf')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                ready = False
                for _ in range(200):
                    if process.poll() is not None:
                        self.fail(process.stdout.read().decode()[:4000])
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1) as connection:
                            connection.sendall(b'zPING\0'); ready = gateway.receive(connection) == 'PONG'
                        if ready: break
                    except OSError: time.sleep(0.05)
                self.assertTrue(ready, 'ClamAV failed to start')
                with patch.dict(os.environ, {'CLAMD_HOST': '127.0.0.1', 'CLAMD_PORT': str(port)}), patch.object(gateway, 'engine_status', return_value={'engineVersion': '1.5.4'}):
                    self.assertEqual(gateway.scan(PAYLOAD)['verdict'], 'clean')
                    eicar = b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
                    self.assertEqual(gateway.scan(eicar)['verdict'], 'blocked')
            finally:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                process.stdout.close()


if __name__ == '__main__':
    unittest.main()
