"""PHP hosting tools. Credentials are read only from the ignored .vscode/ssh.json.

Requires Python with Paramiko. Run with `exec` and pipe a shell script on stdin,
or `validate` to upload and test an isolated copy, or `deploy` after validation.
"""
import json
import pathlib
import posixpath
import shlex
import sys
import time

import paramiko

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / '.vscode/ssh.json').read_text(encoding='utf-8-sig'))
SSH = paramiko.SSHClient()
SSH.load_system_host_keys()
# Use the local deployment file's explicitly supplied host. Save the key for
# subsequent connections, so a changed server key is rejected.
HOST_KEYS = ROOT / '.vscode/ssh-known-hosts'
if HOST_KEYS.exists():
    SSH.load_host_keys(str(HOST_KEYS))
SSH.set_missing_host_key_policy(paramiko.AutoAddPolicy())
SSH.connect(CFG['host'], port=CFG.get('port', 22), username=CFG['username'],
            password=CFG.get('password'), key_filename=CFG.get('privateKeyPath'),
            timeout=20, allow_agent=False, look_for_keys=False)
SSH.save_host_keys(str(HOST_KEYS))
SFTP = SSH.open_sftp()
SHELL_BASE = '/' + CFG['remotePath'].strip('/')
stdin, stdout, stderr = SSH.exec_command('printf %s "$HOME"')
home = '/' + stdout.read().decode().strip('/')
# This hosting exposes $HOME as / in SFTP, but SSH uses the physical path.
if SHELL_BASE.startswith(home + '/'):
    SFTP_BASE = SHELL_BASE[len(home):]
else:
    stdin, stdout, stderr = SSH.exec_command('cd "$HOME" && pwd -P')
    physical_home = '/' + stdout.read().decode().strip().strip('/')
    if SHELL_BASE.startswith(physical_home + '/'):
        SFTP_BASE = SHELL_BASE[len(physical_home):]
    else:
        SFTP_BASE = SHELL_BASE


def mkdir(path, mode=0o755):
    try:
        SFTP.stat(path)
    except FileNotFoundError:
        mkdir(posixpath.dirname(path), mode)
        SFTP.mkdir(path, mode)


def put_tree(local, remote, private=False):
    mkdir(remote, 0o700 if private else 0o755)
    for file in sorted(pathlib.Path(local).rglob('*')):
        relative = file.relative_to(local).as_posix()
        if relative.startswith('.private/') or relative == '.private':
            continue
        target = remote + '/' + relative
        if file.is_dir():
            mkdir(target, 0o700 if private else 0o755)
        elif file.is_file():
            SFTP.put(str(file), target)
            SFTP.chmod(target, 0o600 if private else 0o644)


def run(script):
    stdin, stdout, stderr = SSH.exec_command('bash -se', timeout=900)
    stdin.write(script)
    stdin.channel.shutdown_write()
    # Drain both streams; the shell scripts used here produce bounded output.
    for line in stdout:
        print(line, end='', flush=True)
    error = stderr.read().decode(errors='replace')
    if error:
        print(error, file=sys.stderr, end='', flush=True)
    code = stdout.channel.recv_exit_status()
    if code:
        raise SystemExit(code)


try:
    command = sys.argv[1]
    private = SFTP_BASE + '/.private'
    if command == 'exec':
        run(sys.stdin.read())
    elif command == 'validate':
        mkdir(private, 0o700)
        with SFTP.open(private + '/.htaccess', 'w') as f:
            f.write('Require all denied\n')
        stage = private + '/validation'
        put_tree(ROOT / 'dist-php', stage + '/public', private=True)
        SFTP.put(str(ROOT / 'tests/php-http.test.py'), stage + '/test.py')
        SFTP.put(str(ROOT / 'tests/php-google.test.php'), stage + '/google-test.php')
        # Generated media fixtures live in the ignored local build directory.
        mkdir(stage + '/fixtures', 0o700)
        for file in (ROOT / 'dist-php/.private/test-fixtures').glob('*'):
            SFTP.put(str(file), stage + '/fixtures/' + file.name)
        run('set -e\n' + 'cd ' + shlex.quote(SHELL_BASE + '/.private/validation') + '\n'
            + 'find public -name "*.php" -print0 | xargs -0 -n1 /usr/bin/php8.4-cli -l\n'
            + 'python3 test.py\n'
            + '/usr/bin/php8.4-cli google-test.php\n')
    elif command == 'init':
        mkdir(private, 0o700)
        with SFTP.open(private + '/.htaccess', 'w') as f:
            f.write('Require all denied\n')
        try:
            SFTP.stat(private + '/.env')
            print('Existing private environment preserved.')
        except FileNotFoundError:
            # Use the existing local secrets; replace only deployment paths.
            values = {}
            for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
                if '=' in line and not line.lstrip().startswith('#'):
                    key, value = line.split('=', 1)
                    values[key.strip()] = value.strip()
            values.update(SITE_URL=CFG['siteUrl'].rstrip('/'), DATA_DIR=SHELL_BASE + '/.private/data',
                          FFMPEG_PATH=SHELL_BASE + '/.private/bin/ffmpeg', FFPROBE_PATH=SHELL_BASE + '/.private/bin/ffprobe',
                          GOOGLE_PHOTOS_REDIRECT_URI=CFG['siteUrl'].rstrip('/') + '/admin/google-photos/callback')
            for key in ['ADMIN_PASSWORD', 'SESSION_SECRET']:
                if len(values.get(key, '').strip('\"\'')) < (12 if key == 'ADMIN_PASSWORD' else 32):
                    raise SystemExit('Missing or invalid local ' + key)
            with SFTP.open(private + '/.env', 'w') as f:
                f.write('\n'.join(key + '=' + value for key, value in values.items()) + '\n')
            SFTP.chmod(private + '/.env', 0o600)
            print('Private environment installed; secrets not displayed.')
        try:
            SFTP.stat(private + '/data/seretiny.sqlite')
            print('Existing database and media preserved.')
        except FileNotFoundError:
            source = ROOT / 'dist-php/.private/initial-data'
            if not (source / 'seretiny.sqlite').exists():
                raise SystemExit('First export a consistent local database with scripts/export-php-data.mjs')
            mkdir(private + '/data', 0o700)
            for directory in ['originals', 'media']:
                put_tree(source / directory, private + '/data/' + directory, private=True)
            SFTP.put(str(source / 'seretiny.sqlite'), private + '/data/initial.sqlite')
            SFTP.chmod(private + '/data/initial.sqlite', 0o600)
            run('mv ' + shlex.quote(SHELL_BASE + '/.private/data/initial.sqlite') + ' '
                + shlex.quote(SHELL_BASE + '/.private/data/seretiny.sqlite') + '\n')
            print('Initial database and original media installed.')
    elif command == 'deploy':
        # Preserve the private environment, database and originals on every run.
        mkdir(private, 0o700)
        with SFTP.open(private + '/.htaccess', 'w') as f:
            f.write('Require all denied\n')
        stamp = time.strftime('%Y%m%d-%H%M%S', time.gmtime())
        backup = SHELL_BASE + '/.private/backups/' + stamp
        run('mkdir -p ' + shlex.quote(backup) + '\n'
            + 'cd ' + shlex.quote(SHELL_BASE) + '\n'
            + 'if [ -f index.php ]; then tar -czf ' + shlex.quote(backup + '/app.tar.gz')
            + ' --exclude=.private --exclude=assets .; fi\n'
            + 'if [ -f .private/data/seretiny.sqlite ]; then /usr/bin/php8.4-cli -r '
            + shlex.quote('$s=new SQLite3(".private/data/seretiny.sqlite"); $s->backup(new SQLite3($argv[1]));')
            + ' ' + shlex.quote(backup + '/seretiny.sqlite') + '; fi\n')
        # Assets are content-addressed; keep old ones for clients already open.
        put_tree(ROOT / 'dist-php/assets', SFTP_BASE + '/assets')
        put_tree(ROOT / 'dist-php/server', SFTP_BASE + '/server')
        for file in (ROOT / 'dist-php').iterdir():
            if file.is_file() and file.name != 'index.php':
                SFTP.put(str(file), SFTP_BASE + '/' + file.name)
                SFTP.chmod(SFTP_BASE + '/' + file.name, 0o644)
        SFTP.put(str(ROOT / 'dist-php/index.php'), SFTP_BASE + '/index.php.next')
        SFTP.chmod(SFTP_BASE + '/index.php.next', 0o644)
        run('mv ' + shlex.quote(SHELL_BASE + '/index.php.next') + ' ' + shlex.quote(SHELL_BASE + '/index.php') + '\n')
        print('Application deployed. Private data preserved.')
    else:
        raise SystemExit('Usage: remote-php.py exec|validate|init|deploy')
finally:
    SFTP.close()
    SSH.close()
