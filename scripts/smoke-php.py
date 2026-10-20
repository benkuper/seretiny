"""Read-only production smoke checks plus an administrator login/logout.

No test content is created and no editorial data is changed.
"""
import http.cookiejar
import json
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
cfg = json.loads((root / '.vscode/ssh.json').read_text(encoding='utf-8-sig'))
base = cfg['siteUrl'].rstrip('/')
cookies = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))


def request(path, data=None, accept='application/json', method=None, headers=None):
    headers = {'Accept': accept, **(headers or {})}
    if data is not None:
        data = urllib.parse.urlencode(data).encode()
    try:
        response = client.open(urllib.request.Request(base + path, data=data, method=method, headers=headers), timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    body = response.read()
    return response.status, body, response.headers


def boot(path):
    code, body, headers = request(path)
    assert code == 200 and 'application/json' in headers.get('Content-Type', ''), (path, code)
    return json.loads(body)


public = boot('/')
days = public['data']['days']
media = [photo for day in days for photo in day['photos']]
assert public['page'] == 'public'
print(f'Public journal: {len(days)} days, {len(media)} media.')
for photo in media:
    for variant in ['thumb', 'large']:
        code, body, headers = request(f'/media/{photo["id"]}/{variant}', method='HEAD')
        assert code == 200 and headers.get('Content-Type') == 'image/webp', (photo['id'], variant, code)
    if photo['kind'] == 'video':
        code, body, headers = request(f'/media/{photo["id"]}/video', headers={'Range': 'bytes=0-15'})
        assert code == 206 and len(body) == 16
print('All public media routes verified.')

for path in ['/.private/.env', '/.private/data/seretiny.sqlite', '/server/bootstrap.php', '/.vite/manifest.json']:
    assert request(path)[0] in (403, 404), path
print('Private configuration, database and PHP modules inaccessible over HTTP.')

code, body, headers = request('/', accept='text/html')
html = body.decode()
assert code == 200 and not html.lstrip().startswith('<?php')
assets = re.findall(r'(?:src|href)="([^"]+)"', html)
base_path = urllib.parse.urlparse(base).path.rstrip('/')
for asset in assets:
    assert asset.startswith(base_path + '/'), asset
    code, body, headers = request(asset[len(base_path):], accept='*/*')
    assert code == 200, (asset, code)
    if asset.endswith('.css'):
        stylesheet = body.decode()
        assert 'fonts.googleapis.com' not in stylesheet, 'Fonts must not depend on an external stylesheet'
        assert '@font-face' in stylesheet, 'Missing bundled font declarations'
        font_paths = set(re.findall(r'url\([\"\']?([^\)\"\']+\.woff2)[\"\']?\)', stylesheet))
        assert font_paths, 'Missing local WOFF2 fonts'
        for font_path in font_paths:
            assert font_path.startswith(base_path + '/assets/'), font_path
            font_code, font_body, font_headers = request(font_path[len(base_path):], accept='font/woff2')
            assert font_code == 200 and font_body.startswith(b'wOF2'), (font_path, font_code)
        print(f'{len(font_paths)} local WOFF2 fonts verified, with no Google Fonts request.')
for path in ['/workshop.svg', '/photo-paper.svg', '/photo-brush-mask-subtle.png']:
    assert request(path, accept='*/*')[0] == 200
print('HTML, JavaScript, CSS and workshop textures verified.')

assert request('/admin')[0] == 401
login = boot('/admin/login')
password = None
for line in (root / '.env').read_text(encoding='utf-8-sig').splitlines():
    if line.startswith('ADMIN_PASSWORD='):
        password = line.split('=', 1)[1].strip().strip('"\'')
assert password
code, body, _ = request('/admin/login', {'password': password, '_csrf': login['csrf']})
assert code == 200 and json.loads(body)['type'] == 'redirect'
admin = boot('/admin')
assert admin['page'] == 'admin'
for view in ['days', 'photos', 'imports', 'chapters', 'comments']:
    assert boot('/admin?view=' + view)['data']['view'] == view
assert request('/admin?/createDay', {'date': '1900-01-01'})[0] == 400
code, body, _ = request('/admin?/logout', {'_csrf': admin['csrf']})
assert code == 200 and json.loads(body)['type'] == 'redirect'
assert request('/admin')[0] == 401
print('Administrator login, all five views, CSRF rejection and logout verified.')
print('HTTPS production smoke checks passed.')
