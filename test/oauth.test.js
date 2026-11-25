import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLogin } from '../lib/oauth.js';

const binary = fileURLToPath(new URL('../bin/tick.js', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tick-oauth-'));
  let auth,
    serial = 0,
    access,
    refreshToken;
  const grants = new Map();
  const state = { grants, rotations: 0, writes: 0, admin: true, rejectRevoke: false };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const fields = new URLSearchParams(body);
    function reply(status, json) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    }
    const params = auth?.searchParams;
    if (req.url === '/oauth/token' && req.method === 'POST' && fields.get('client_id') === 'tick-cli') {
      if (fields.get('grant_type') === 'authorization_code') {
        const proof = createHash('sha256')
          .update(fields.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          params.get('code_challenge') !== proof ||
          fields.get('redirect_uri') !== params.get('redirect_uri') ||
          fields.get('code') !== 'approved-code'
        )
          return reply(400, { error: 'invalid_grant' });
      } else if (fields.get('grant_type') === 'refresh_token' && grants.has(fields.get('refresh_token'))) {
        grants.delete(fields.get('refresh_token'));
        state.rotations++;
      } else return reply(400, { error: 'invalid_grant' });
      access = 'secret-access-' + ++serial;
      refreshToken = 'secret-refresh-' + serial;
      grants.set(refreshToken, { access, scope: state.narrow ? 'read' : params.get('scope'), id: serial });
      return reply(200, {
        access_token: access,
        refresh_token: refreshToken,
        scope: state.narrow ? 'read' : params.get('scope'),
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (
      req.url === '/oauth/revoke' &&
      req.method === 'POST' &&
      fields.get('client_id') === 'tick-cli' &&
      grants.has(fields.get('token'))
    ) {
      if (state.rejectRevoke || state.rejectToken === fields.get('token')) return reply(503, {});
      grants.delete(fields.get('token'));
      return reply(200, {});
    }
    if (req.url === '/41/api/v2/me.json' && req.headers.authorization === 'Token token=legacy')
      return reply(200, { id: 8, first_name: 'Lee' });
    if (req.url === '/41/api/v2/users.json' && req.headers.authorization === 'Token token=legacy')
      return reply(200, [{ id: 8 }]);
    const grant = Array.from(grants.values()).find(
      (item) => req.headers.authorization === 'Bearer ' + item.access
    );
    if (!grant) return reply(401, {});
    if (req.url === '/oauth/me')
      return reply(200, {
        company: 'Harbor Studio',
        email: 'lee@example.test',
        subscription_id: 41,
        user_id: 8,
        connection_id: String(grant.id),
        scope: grant.scope,
      });
    if (req.url === '/41/api/v2/me.json') return reply(200, { id: 8, first_name: 'Lee' });
    if (req.url === '/41/api/v2/users.json') return reply(200, [{ id: 9 }, { id: 8, first_name: 'Lee' }]);
    if (req.url === '/41/api/v2/management/lookup.json?kind=client&name=Studio' && req.method === 'GET') {
      state.lookups = (state.lookups || 0) + 1;
      return reply(200, [{ id: 3, name: 'Studio' }]);
    }
    if (req.url === '/41/api/v2/clients.json' && req.method === 'POST') {
      state.writes++;
      if (!state.admin) return reply(403, {});
      return reply(201, { id: 3, name: JSON.parse(body).client.name });
    }
    if (req.url === '/41/api/v2/clients/3.json' && req.method === 'PUT') {
      state.writes++;
      return reply(200, { id: 3, name: JSON.parse(body).client.name });
    }
    if (req.url === '/41/api/v2/timers/1/pause.json' && req.method === 'PUT') {
      state.writes++;
      return reply(401, {});
    }
    if (req.url === '/41/api/v2/timers/1.json') return reply(200, { id: 1, last_started_at: 'today' });
    reply(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = join(dir, 'tick', 'account.json');
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  function run(args, options = {}, input = '') {
    const p = spawn(process.execPath, [binary, ...args], {
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: dir, TICK_BASE_URL: base, ...options },
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    p.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    p.stdin.end(input);
    const done = once(p, 'close').then(([code]) => ({ code, stdout, stderr }));
    return { p, done };
  }
  async function login(args = [], deny = false, launch = false) {
    const opened = join(dir, 'opened-url');
    if (launch)
      await writeFile(join(dir, 'xdg-open'), '#!/bin/sh\nprintf "%s" "$1" > "$OPENED_URL"\n', {
        mode: 0o700,
      });
    const { p, done } = run(['login', ...(launch ? [] : ['--no-browser']), ...args], {
      PATH: dir,
      OPENED_URL: opened,
    });
    try {
      let output = '';
      for await (const chunk of p.stderr.iterator({ destroyOnReturn: false })) {
        output += chunk;
        const match = output.match(/^(http:\/\/[^\n]+)\n/m);
        if (match) {
          auth = new URL(match[1]);
          break;
        }
      }
      assert.equal(auth.origin, base);
      assert.equal(auth.pathname, '/oauth/authorize');
      const params = auth.searchParams;
      assert.equal(params.get('client_id'), 'tick-cli');
      assert.equal(params.get('response_type'), 'code');
      assert.equal(params.get('code_challenge_method'), 'S256');
      assert.equal(params.get('scope'), args.includes('--allow-writes') ? 'read time:write' : 'read');
      const target = new URL(params.get('redirect_uri'));
      assert.equal(target.hostname, '127.0.0.1');
      assert.equal(target.pathname, '/callback');
      target.searchParams.set('state', 'invalid');
      assert.equal((await fetch(target)).status, 400);
      target.searchParams.set('state', params.get('state'));
      target.searchParams.set(deny ? 'error' : 'code', deny ? 'access_denied' : 'approved-code');
      const rejectedHost = await new Promise((resolve, reject) => {
        httpGet(target, { headers: { Host: 'example.test' } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on('error', reject);
      });
      assert.equal(rejectedHost, 400);
      assert.equal((await fetch(target)).status, 200);
      const result = await done;
      if (launch) assert.equal(await readFile(opened, 'utf8'), auth.href);
      assert.doesNotMatch(result.stdout + result.stderr, /approved-code|secret-access|secret-refresh/);
      return result;
    } finally {
      p.kill();
    }
  }
  return { state, base, profile, run: (args, env, input) => run([...args, '--json'], env, input).done, login };
}

test('browser login, grant identity, rotated credentials, pinned session, and revocation', async (t) => {
  const f = await fixture(t);
  const login = await f.login(['--json']);
  assert.equal(login.code, 0, login.stderr);
  assert.deepEqual(JSON.parse(login.stdout), {
    signed_in: true,
    subscription_id: 41,
    user_id: 8,
    scope: 'read',
  });
  assert.equal((await stat(f.profile)).mode & 0o777, 0o600);
  const old = JSON.parse((await f.run(['session'])).stdout).binding;
  const write = await f.run(['timers', 'pause', '1']);
  assert.equal(JSON.parse(write.stderr).error.code, 'insufficient_scope');
  const data = JSON.parse(await readFile(f.profile));
  await writeFile(f.profile, JSON.stringify({ ...data, expiresAt: 0 }));
  const concurrent = await Promise.all(
    [1, 2, 3].map(() => f.run(['account'], { TICK_EXPECTED_SESSION: old }))
  );
  for (const result of concurrent)
    assert.deepEqual(JSON.parse(result.stdout), { subscription_id: 41, user_id: 8, user_name: 'Lee' });
  assert.equal(f.state.rotations, 1);
  assert.equal(JSON.parse((await f.run(['session'])).stdout).binding, old);
  assert.equal((await f.login(['--allow-writes'])).code, 0);
  assert.notEqual(JSON.parse((await f.run(['session'])).stdout).binding, old);
  const stale = await f.run(['account'], { TICK_EXPECTED_SESSION: old });
  assert.equal(JSON.parse(stale.stderr).error.code, 'session_changed');
  const rejected = await f.run(['timers', 'pause', '1']);
  assert.equal(JSON.parse(rejected.stderr).error.status, 401);
  assert.equal(f.state.writes, 1);
  f.state.rejectRevoke = true;
  assert.equal((await f.run(['logout'])).code, 1);
  await stat(f.profile);
  f.state.rejectRevoke = false;
  assert.equal(JSON.parse((await f.run(['logout'])).stdout).connection_revoked, true);
  await assert.rejects(stat(f.profile), { code: 'ENOENT' });
});

test('browser login confirms the selected company and email', async (t) => {
  const f = await fixture(t);
  const result = await f.login();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'You are now logged into the Harbor Studio account as lee@example.test.\n');
  assert.doesNotMatch(await readFile(f.profile, 'utf8'), /Harbor Studio|lee@example\.test/);
});

test('declined consent preserves the previous profile', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login()).code, 0);
  const previous = await readFile(f.profile);
  const denied = await f.login([], true);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /declined/);
  assert.deepEqual(await readFile(f.profile), previous);
});

test('an unattended callback closes after the deadline', async () => {
  await assert.rejects(browserLogin('http://127.0.0.1', { noBrowser: true, timeout: 15 }), /timed out/);
});

test('consent can grant read access when the CLI requested writes', async (t) => {
  const f = await fixture(t);
  f.state.narrow = true;
  const login = await f.login(['--allow-writes', '--json']);
  assert.equal(login.code, 0, login.stderr);
  assert.equal(JSON.parse(login.stdout).scope, 'read');
  const write = await f.run(['timers', 'pause', '1']);
  assert.equal(JSON.parse(write.stderr).error.code, 'insufficient_scope');
});

test(
  'bare login launches the system browser with the authorization URL',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.login([], false, true)).code, 0);
  }
);

test('switching off time writes and then using legacy credentials revokes both previous connections', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login(['--allow-writes'])).code, 0);
  const old = JSON.parse(await readFile(f.profile));
  assert.equal((await f.login()).code, 0);
  const current = JSON.parse(await readFile(f.profile));
  const me = (profile) =>
    fetch(f.base + '/oauth/me', { headers: { Authorization: 'Bearer ' + profile.token } });
  assert.equal((await me(old)).status, 401);
  assert.equal((await (await me(current)).json()).scope, 'read');
  assert.equal(f.state.grants.size, 1);
  const legacy = await f.run(['login', '--subscription-id', '41', '--token-stdin'], {}, 'legacy');
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal((await me(current)).status, 401);
  assert.equal(f.state.grants.size, 0);
});

test('failed replacement preserves the old login and discards the newly authorized grant', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login()).code, 0);
  const old = await readFile(f.profile);
  f.state.rejectToken = JSON.parse(old).refreshToken;
  const replacement = await f.login(['--allow-writes']);
  assert.equal(replacement.code, 1);
  assert.deepEqual(await readFile(f.profile), old);
  assert.deepEqual([...f.state.grants.keys()], [f.state.rejectToken]);
});

test('replacement does not revoke through an unrelated saved origin', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login()).code, 0);
  const old = JSON.parse(await readFile(f.profile));
  old.origin = 'http://127.0.0.1:1';
  await writeFile(f.profile, JSON.stringify(old));
  const replacement = await f.login();
  assert.equal(replacement.code, 1);
  assert.match(replacement.stderr, /previous Tick origin/);
  assert.deepEqual(JSON.parse(await readFile(f.profile)), old);
  assert.deepEqual([...f.state.grants.keys()], [old.refreshToken]);
});

test('replacement preserves a malformed or unreadable profile and reports how to recover', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login()).code, 0);
  const invalid = '{"secret":"private credential",';
  await writeFile(f.profile, invalid);
  const broken = await f.login();
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.includes(f.profile));
  assert.match(
    broken.stderr,
    /Move that file aside locally, disconnect the previous CLI approval in Tick’s Connected apps, then run tick login/
  );
  assert.doesNotMatch(broken.stderr, /private credential/);
  assert.equal(await readFile(f.profile, 'utf8'), invalid);
  assert.equal(f.state.grants.size, 1);

  await rm(f.profile);
  await mkdir(f.profile);
  const unreadable = await f.login();
  assert.equal(unreadable.code, 1);
  assert.ok(unreadable.stderr.includes(f.profile));
  assert.match(unreadable.stderr, /Check its file type and permissions/);
  assert.ok((await stat(f.profile)).isDirectory());
  assert.equal(f.state.grants.size, 1);
});

test('account changes follow the current role on the same browser login', async (t) => {
  const f = await fixture(t);
  const create = ['clients', 'create', '--name', 'Studio'];
  const login = await f.login(['--json']);
  assert.equal(login.code, 0, login.stderr);
  assert.equal(JSON.parse(login.stdout).scope, 'read');
  let client = await f.run(create);
  assert.equal(client.code, 0, client.stderr);
  f.state.admin = false;
  client = await f.run(create);
  assert.equal(client.code, 1);
  const error = JSON.parse(client.stderr).error;
  assert.equal(error.status, 403);
  assert.match(error.message, /role/);
  assert.doesNotMatch(error.message, /login/);
  assert.equal(f.state.writes, 2);
});

test('a named account edit can be previewed and submitted after normal login', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.login([])).code, 0);
  const edit = ['clients', 'edit', '--client', 'Studio', '--name', 'Agency'];
  const preview = await f.run([...edit, '--dry-run']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).path, '/41/api/v2/clients/3.json');
  assert.equal(f.state.writes, 0);
  const result = await f.run(edit);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id: 3, name: 'Agency' });
  assert.equal(f.state.lookups, 2);
  assert.equal(f.state.writes, 1);
});
