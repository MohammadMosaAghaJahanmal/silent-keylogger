"""Observe one real five-minute interval in the installed, unchanged PDF.exe.

Requires PDF to be stopped first and port 8000 to be free. Leaves PDF running.
Stores the received count file locally in build as the test server's receipt.
"""
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import time
import winreg
import uuid

ROOT = Path(__file__).resolve().parents[1]
EXE = Path(os.environ['LOCALAPPDATA']) / 'Programs' / 'PDF' / 'PDF.exe'


def main():
    # The production client resolves its executable directory, regardless of cwd.
    path = EXE.with_name('yourtext.txt')
    before = path.read_bytes() if path.exists() else b''
    (ROOT / 'build' / 'phase3-counts-before-interval.txt').write_bytes(before)
    seeded_initial_count = False
    if not before:
        # Preserve the existing cumulative number if a previous upload cleared
        # the text. With no prior checkpoint, an initial zero fabricates no keys.
        initial = 0
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\PDF\CounterState') as key:
                value, kind = winreg.QueryValueEx(key, 'LastTotal')
                if kind == winreg.REG_QWORD:
                    initial = value
        except FileNotFoundError:
            pass
        path.write_bytes(f'\r\nTotal key presses: {initial}\r\n'.encode('ascii'))
        seeded_initial_count = True
    observed = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            data = self.rfile.read(int(self.headers['Content-Length']))
            message = BytesParser(policy=policy.default).parsebytes(
                b'Content-Type: ' + self.headers['Content-Type'].encode('ascii') + b'\r\n\r\n' + data)
            parts = list(message.iter_parts())
            assert self.path == '/create' and len(parts) == 4
            fields = {part.get_param('name', header='content-disposition'): part for part in parts}
            assert set(fields) == {'file', 'device_id', 'device_name', 'os_version'}
            device = {name: fields[name].get_payload(decode=True).decode('utf-8')
                      for name in ('device_id', 'device_name', 'os_version')}
            uuid.UUID(device['device_id'])
            assert device['device_name'] and device['os_version']
            part = fields['file']
            assert part.get_param('name', header='content-disposition') == 'file'
            assert part.get_filename() == 'yourtext.txt'
            payload = part.get_payload(decode=True)
            (ROOT / 'build' / 'production-upload-received.txt').write_bytes(payload)
            observed.update(elapsed_seconds=time.monotonic() - started, payload_bytes=len(payload), device=device)
            # Preserve timing evidence even if immediate cleanup observation
            # encounters a transient file-replacement/sharing race.
            (ROOT / 'build' / 'production-interval-observed.json').write_text(
                json.dumps(observed, indent=2), encoding='utf-8')
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()

    server = HTTPServer(('127.0.0.1', 8000), Handler)
    server.timeout = 1
    started = time.monotonic()
    process = subprocess.Popen([str(EXE)], creationflags=subprocess.CREATE_NO_WINDOW)
    print('Watching the production five-minute interval; PDF PID', process.pid, flush=True)
    try:
        while not observed and time.monotonic() - started < 350:
            if process.poll() is not None:
                raise RuntimeError('PDF exited before its upload interval')
            server.handle_request()
        assert observed and 299 <= observed['elapsed_seconds'] < 350, observed
        deadline = time.monotonic() + 5
        payload = (ROOT / 'build' / 'production-upload-received.txt').read_bytes()
        remaining = payload
        while time.monotonic() < deadline:
            try:
                remaining = path.read_bytes()
            except (FileNotFoundError, PermissionError):
                time.sleep(.02)
                continue
            if not payload or not remaining.startswith(payload):
                break
            time.sleep(.02)
        assert path.exists() and (not payload or not remaining.startswith(payload))
        observed.update(status='PASSED', seeded_initial_count=seeded_initial_count, remaining_bytes=len(remaining),
                        endpoint='http://127.0.0.1:8000/create', file_retained=True)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\PDF\CounterState') as key:
            checkpoint, kind = winreg.QueryValueEx(key, 'LastTotal')
            assert kind == winreg.REG_QWORD
            observed['cumulative_checkpoint'] = checkpoint
        (ROOT / 'build' / 'production-interval.json').write_text(json.dumps(observed, indent=2), encoding='utf-8')
        print('PASS:', json.dumps(observed), flush=True)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
