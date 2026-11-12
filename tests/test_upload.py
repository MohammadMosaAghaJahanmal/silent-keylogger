"""Real loopback HTTP integration tests, using only Python's standard library.

Binds an automatically assigned loopback port. It never stops an existing listener and only
uses count fixtures under a uniquely created directory in this checkout/build.
"""
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / 'build' / 'upload_test.exe'
COUNTS = b'\r\nTotal key presses: 42\r\n'
TAIL = b'\r\nTotal key presses: 46\r\n'
DEVICE = {'device_id': '12345678-1234-4567-89ab-123456789abc',
          'device_name': 'TEST-DEVICE', 'os_version': 'Windows 11 (build 26200), x64'}
TEST_PORT = None


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address):
        super().__init__(address, Handler)
        self.scenarios = []
        self.requests = []
        self.errors = []
        self.guard = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            self.connection.settimeout(5)
            length = int(self.headers['Content-Length'])
            body = self.rfile.read(length)
            assert len(body) == length
            message = BytesParser(policy=policy.default).parsebytes(
                b'Content-Type: ' + self.headers['Content-Type'].encode('ascii')
                + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
            assert message.get_content_type() == 'multipart/form-data'
            parts = list(message.iter_parts())
            assert len(parts) == 4
            fields = {part.get_param('name', header='content-disposition'): part for part in parts}
            assert set(fields) == {'file', *DEVICE}
            for name, expected in DEVICE.items():
                assert fields[name].get_payload(decode=True).decode('utf-8') == expected
            part = fields['file']
            assert part.get_content_disposition() == 'form-data'
            assert part.get_param('name', header='content-disposition') == 'file'
            assert part.get_filename() == 'yourtext.txt'
            payload = part.get_payload(decode=True)
            assert self.path == '/create'
            with self.server.guard:
                assert self.server.scenarios, 'Unexpected request or retry'
                scenario = self.server.scenarios.pop(0)
                self.server.requests.append({'time': time.monotonic(), 'bytes': len(payload)})
            assert payload == scenario['expected'], 'Uploaded file bytes changed'
            path = scenario.get('path')
            if scenario.get('append'):
                with path.open('ab') as output:
                    output.write(scenario['append'])
            if scenario.get('rewrite') is not None:
                path.write_bytes(scenario['rewrite'])
            if scenario.get('replace'):
                replacement = path.with_suffix('.replacement')
                replacement.write_bytes(COUNTS)
                os.replace(replacement, path)
            if scenario.get('marker'):
                scenario['marker'].write_text('request received', encoding='ascii')
            time.sleep(scenario.get('delay', 0))
            if scenario.get('disconnect'):
                self.close_connection = True
                return
            status = scenario.get('status', 200)
            self.close_connection = True
            self.send_response(status)
            if status == 302:
                self.send_header('Location', 'http://127.0.0.1:8001/should-not-be-followed')
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.server.errors.append(repr(error))
            self.close_connection = True


def run_client(mode, path, marker=None):
    command = [str(CLIENT), mode, str(path)]
    if marker:
        command.append(str(marker))
    return subprocess.run(command, capture_output=True, text=True, timeout=12,
                          env={**os.environ, 'PDF_TEST_PORT': str(TEST_PORT)})


def main():
    global TEST_PORT
    results = []
    with tempfile.TemporaryDirectory(prefix='pdf-http-test-', dir=ROOT / 'build') as temp:
        directory = Path(temp).resolve()
        assert directory.parent == (ROOT / 'build').resolve()
        path = directory / 'yourtext.txt'
        server = Server(('127.0.0.1', 0))
        TEST_PORT = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def check(name, scenario, mode='once', expected_exit=0, remaining=b''):
            path.write_bytes(COUNTS)
            scenario.update(expected=COUNTS, path=path)
            marker = directory / 'received.marker'
            if marker.exists():
                marker.unlink()
            if mode in ('stop', 'nonblocking'):
                scenario['marker'] = marker
            with server.guard:
                server.scenarios = [scenario]
            result = run_client(mode, path, marker if mode in ('stop', 'nonblocking') else None)
            assert result.returncode == expected_exit, (name, result.returncode, result.stdout, result.stderr)
            assert path.exists() and path.read_bytes() == remaining, name
            assert not server.errors, server.errors
            assert not server.scenarios, name
            results.append(name)
            print('PASS:', name, flush=True)
            if result.stdout.strip():
                print(result.stdout.strip(), flush=True)

        try:
            check('HTTP 200 multipart field/file bytes correct; file kept and cleared', {})
            check('HTTP 204 accepted; file kept and cleared', {'status': 204})
            check('HTTP 500 preserves file', {'status': 500}, expected_exit=1, remaining=COUNTS)
            check('HTTP 401 preserves file without authentication retry', {'status': 401}, expected_exit=1, remaining=COUNTS)
            check('HTTP redirect is not followed and preserves file', {'status': 302}, expected_exit=1, remaining=COUNTS)
            check('Disconnected server preserves file', {'disconnect': True}, expected_exit=1, remaining=COUNTS)
            check('Acknowledgment checkpoint failure preserves file', {}, mode='checkpoint_fail', expected_exit=1, remaining=COUNTS)
            check('Records appended during upload are preserved', {'append': TAIL}, remaining=TAIL)
            modified = b'\r\nTotal key presses: 99\r\n'
            check('Changed prefix is not cleared', {'rewrite': modified}, expected_exit=1, remaining=modified)
            check('Replaced file identity is not cleared', {'replace': True}, expected_exit=1, remaining=COUNTS)
            check('Counting/saving stays responsive during slow HTTP', {'delay': 1.0}, mode='nonblocking',
                  remaining=b'\r\nTotal key presses: 100042\r\n')
            check('Shutdown during stalled HTTP completes within maintenance deadline', {'delay': 4.0},
                  mode='stop', remaining=COUNTS)

            path.write_bytes(COUNTS)
            with server.guard:
                server.scenarios = [dict(expected=COUNTS, status=500), dict(expected=COUNTS, status=200)]
                before = len(server.requests)
            started = time.monotonic()
            result = run_client('worker', path)
            assert result.returncode == 0, result.stderr
            requests = server.requests[before:]
            assert len(requests) == 2 and not server.scenarios and not server.errors
            assert requests[0]['time'] - started >= .15
            assert requests[1]['time'] - requests[0]['time'] >= .15
            assert path.exists() and path.stat().st_size == 0
            results.append('Worker waits for interval, retries failure next interval, then clears success')
            print('PASS:', results[-1], flush=True)

            # Exercise streaming with a multi-megabyte body, not a heap copy.
            large = COUNTS * 100000
            path.write_bytes(large)
            server.scenarios = [dict(expected=large)]
            result = run_client('once', path)
            assert result.returncode == 0 and path.exists() and path.stat().st_size == 0
            assert not server.scenarios and not server.errors
            results.append('Multi-megabyte file streams and clears successfully')
            print('PASS:', results[-1], flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

        # With our only server closed, connection refusal must retain the file.
        path.write_bytes(COUNTS)
        result = run_client('once', path)
        assert result.returncode == 1 and path.read_bytes() == COUNTS
        results.append('Unavailable localhost server retains file')
        print('PASS:', results[-1], flush=True)
    report = {'status': 'PASSED', 'tests': results, 'endpoint': f'http://127.0.0.1:{TEST_PORT}/create',
              'production_endpoint': 'http://127.0.0.1:8000/create', 'device_metadata_verified': True,
              'worker_test_interval_ms': 200, 'production_interval_ms': 300000}
    (ROOT / 'build' / 'upload-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
