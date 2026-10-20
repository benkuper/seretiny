"""Integration tests against a real PHP 8.4 HTTP server and isolated SQLite files.

Run by scripts/remote-php.py validate, never against the production database.
"""
import http.cookiejar
import json
import os
import pathlib
import re
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
PHP = '/usr/bin/php8.4-cli'


class Journal(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isolated-', dir=ROOT)
        self.folder = pathlib.Path(self.temp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}/seretiny'
        env_path = self.folder / '.env'
        env_path.write_text(f'ADMIN_PASSWORD=integration-test-password\nSESSION_SECRET={"s" * 64}\nSITE_URL={self.url}\nDATA_DIR={self.folder}/data\nFFMPEG_PATH={ROOT.parent}/bin/ffmpeg\nFFPROBE_PATH={ROOT.parent}/bin/ffprobe\nGOOGLE_PHOTOS_TIME_ZONE=Europe/Paris\n')
        router = self.folder / 'router.php'
        public = ROOT / 'public'
        router.write_text('<?php require ' + json.dumps(str(public / 'index.php')) + ';')
        env = dict(os.environ, SERETINY_ENV=str(env_path))
        self.log = (self.folder / 'server.log').open('w+')
        self.server = subprocess.Popen([PHP, '-S', f'127.0.0.1:{self.port}', str(router)], env=env, stdout=self.log, stderr=self.log)
        self.cookies = http.cookiejar.CookieJar()
        self.databases = []
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        for _ in range(100):
            try:
                self.request('/admin/login')
                break
            except (ConnectionError, urllib.error.URLError):
                time.sleep(.03)
        else:
            raise RuntimeError('PHP test server failed to start')
        status, boot = self.request('/admin/login')
        self.assertEqual(status, 200, boot)
        self.csrf = boot['csrf']

    def tearDown(self):
        for connection in self.databases:
            connection.close()
        self.server.terminate()
        self.server.wait(timeout=10)
        self.log.close()
        self.temp.cleanup()

    def request(self, path, data=None, method=None, headers=None, raw=False):
        headers = {'Accept': 'application/json', **(headers or {})}
        if isinstance(data, dict):
            data = urllib.parse.urlencode(data, doseq=True).encode()
            headers.setdefault('Content-Type', 'application/x-www-form-urlencoded')
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            response = self.client.open(req, timeout=180)
        except urllib.error.HTTPError as error:
            response = error
        content = response.read()
        if raw:
            return response.status, content, response.headers
        try:
            return response.status, json.loads(content)
        except ValueError:
            self.log.flush()
            raise AssertionError(f'Unexpected HTTP {response.status}: {content[:300]!r}; {self.folder.joinpath("server.log").read_text()}')

    def login(self):
        code, result = self.request('/admin/login', {'password': 'integration-test-password', '_csrf': self.csrf})
        self.assertEqual(result['type'], 'redirect', (code, result))
        code, boot = self.request('/admin')
        self.csrf = boot['csrf']
        return boot

    def action(self, name, data=None, code=200):
        status, value = self.request('/admin?/' + name, {'_csrf': self.csrf, **(data or {})})
        self.assertEqual(status, code, value)
        return value

    def create_day(self, date='2024-05-01', title='Le chantier'):
        result = self.action('createDay', {'date': date, 'title_fr': title})
        return int(urllib.parse.parse_qs(urllib.parse.urlparse(result['location']).query)['day'][0])

    def upload(self, filename='camera.jpg', fields=None, action='importPhotos'):
        boundary = '----SereTinyIntegrationBoundary'
        body = bytearray()
        for name, value in {'_csrf': self.csrf, **(fields or {})}.items():
            body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        payload = (ROOT / 'fixtures' / filename).read_bytes()
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="photos[]"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        body.extend(payload)
        body.extend(f'\r\n--{boundary}--\r\n'.encode())
        return self.request('/admin?/' + action, bytes(body), headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})

    def database(self):
        connection = sqlite3.connect(self.folder / 'data/seretiny.sqlite')
        self.databases.append(connection)
        return connection

    def test_authentication_csrf_and_origin(self):
        self.assertEqual(self.request('/admin')[0], 401)
        self.assertEqual(self.request('/admin?/createDay', {'date': '2024-01-01'})[0], 401)
        self.assertEqual(self.request('/admin/login', {'_csrf': self.csrf, 'password': 'wrong'})[0], 401)
        self.login()
        self.assertEqual(self.request('/admin?/createDay', {'date': '2024-01-01'})[0], 400)
        self.assertEqual(self.request('/admin?/createDay', {'date': '2024-01-01', '_csrf': self.csrf}, headers={'Origin': 'https://attacker.invalid'})[0], 400)
        self.action('createDay', {'date': '2024-02-31'}, code=400)
        self.action('bulkPhotos', {'ids[]': ['missing'], 'change_date': 'on', 'date': '2024-01-01'}, code=400)
        self.assertEqual(self.database().execute('select count(*) from days').fetchone()[0], 0)
        self.action('logout')
        self.assertEqual(self.request('/admin')[0], 401)

    def test_import_edit_publish_comment_moderation(self):
        self.login()
        status, result = self.upload(fields={'date': '2024-05-01'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['type'], 'redirect')
        public = self.request('/')[1]['data']['days']
        self.assertEqual(len(public), 1)
        day = public[0]
        photo = day['photos'][0]
        self.assertEqual(photo['taken_at'], '2023-05-01T08:30:00.000')
        self.assertEqual(day['date'], '2024-05-01')
        self.action('editLibraryPhoto', {'id': photo['id'], 'edit': 'caption', 'caption_fr': '</script><script>alert(1)</script>'})
        self.action('editLibraryPhoto', {'id': photo['id'], 'edit': 'date', 'date': '2024-06-01'})
        day = self.request('/')[1]['data']['days'][0]
        self.assertEqual(day['date'], '2024-06-01')
        self.assertIn('</script>', day['photos'][0]['caption_fr'])
        status, html, _ = self.request('/', headers={'Accept': 'text/html'}, raw=True)
        self.assertNotIn(b'</script><script>alert(1)', html)
        self.assertIn(b'\\u003C', html)
        status, result = self.upload(fields={'date': '2025-01-01'})
        self.assertIn('doublon', urllib.parse.unquote(result['location']))
        self.assertEqual(self.database().execute('select count(*) from photos').fetchone()[0], 1)
        comment = json.dumps({'dayId': day['id'], 'author': 'Camille', 'message': 'Super beau chantier !', 'website': ''}).encode()
        status, result = self.request('/api/comments', comment, headers={'Content-Type': 'application/json'})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request('/')[1]['data']['days'][0]['comments'], [])
        pending = self.request('/admin?view=comments')[1]['data']['comments']
        self.action('moderate', {'id': pending[0]['id'], 'decision': 'approve'})
        self.assertEqual(len(self.request('/')[1]['data']['days'][0]['comments']), 1)
        self.action('bulkDays', {'ids[]': [str(day['id'])], 'decision': 'hide'})
        self.action('logout')
        self.assertEqual(self.request('/')[1]['data']['days'], [])
        self.assertEqual(self.request('/media/' + photo['id'] + '/large', raw=True)[0], 404)

    def test_chapters_batches_and_transaction_rollback(self):
        self.login()
        self.action('addChapter', {'title_fr': 'Le début', 'start_date': '2023-01-01'})
        self.action('addChapter', {'title_fr': 'La suite', 'start_date': '2024-01-01'})
        first = self.create_day('2023-05-01')
        second = self.create_day('2024-05-01')
        self.assertEqual(self.upload(fields={'day_id': first}, action='upload')[0], 200)
        self.assertEqual(self.upload('undated.png', {'day_id': second}, action='upload')[0], 200)
        boot = self.request('/admin')[1]
        self.assertEqual([d['chapter_fr'] for d in boot['data']['days']], ['Le début', 'La suite'])
        ids = [d['photos'][0]['id'] for d in boot['data']['days']]
        self.action('bulkPhotos', {'ids[]': [ids[0], 'stale'], 'change_date': 'on', 'date': '2025-01-01'}, code=400)
        self.assertFalse(self.database().execute("select 1 from days where date='2025-01-01'").fetchone())
        self.action('bulkPhotos', {'ids[]': ids, 'change_date': 'on', 'date': '2025-01-01', 'change_caption_fr': 'on', 'caption_fr': 'Le bois'})
        target = self.request('/')[1]['data']['days'][0]
        self.assertEqual(len(target['photos']), 2)
        self.assertEqual(target['chapter_fr'], 'La suite')
        self.assertTrue(all(p['caption_fr'] == 'Le bois' for p in target['photos']))
        self.action('deletePhoto', {'id': ids[0], 'day_id': target['id']})
        self.assertFalse(list((self.folder / 'data/media').glob(ids[0] + '*')))

    def test_capture_import_invalid_media_and_video_ranges(self):
        self.login()
        status, result = self.upload('undated.png', {'destination': 'capture'})
        self.assertEqual(status, 400, result)
        self.assertEqual(self.database().execute('select count(*) from days').fetchone()[0], 0)
        status, result = self.upload('clip.mp4', {'destination': 'capture'})
        self.assertEqual(status, 200, result)
        day = self.request('/')[1]['data']['days'][0]
        self.assertEqual(day['date'], '2023-05-01')
        clip = day['photos'][0]
        self.assertEqual(clip['kind'], 'video')
        route = '/media/' + clip['id'] + '/video'
        status, content, headers = self.request(route, raw=True)
        self.assertEqual(status, 200)
        status, partial, headers = self.request(route, headers={'Range': 'bytes=4-15'}, raw=True)
        self.assertEqual(status, 206)
        self.assertEqual(partial, content[4:16])
        self.assertEqual(self.request(route, headers={'Range': 'bytes=99999999-'}, raw=True)[0], 416)
        self.assertEqual(self.request(route, headers={'Range': 'bytes=0-0,2-2'}, raw=True)[0], 416)
        self.action('bulkDays', {'ids[]': [str(day['id'])], 'decision': 'hide'})
        self.action('logout')
        self.assertEqual(self.request(route, raw=True)[0], 404)


if __name__ == '__main__':
    unittest.main(verbosity=2)
