import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const binary = fileURLToPath(new URL('../bin/tick.js', import.meta.url));
const token = 'fixture-token';
async function cli(env, args, input = '') {
  const p = spawn(process.execPath, [binary, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: 'pipe',
  });
  let stdout = '',
    stderr = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stderr.on('data', (d) => (stderr += d));
  const done = once(p, 'close');
  p.stdin.end(input);
  const [code] = await done;
  return { code, stdout, stderr };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tick-cli-test-'));
  const calls = [];
  const tasks = [{ id: 9, name: 'Design', budget: 12, project_id: 5, total_hours: 13.25 }];
  const entries = [{ id: 4, task_id: 9, user_id: 7, date: '2026-11-24', hours: 0.5, locked: false }];
  const users = [{ id: 7, first_name: 'Ana', last_name: 'Reed', email: 'ana@local.test' }];
  let timer = { id: 2, task_id: 9, last_started_at: null, accumulated_seconds: 1800 };
  let me = { id: 7, first_name: 'Ana', last_name: 'Reed' };
  let redirect = false;
  let failure;
  const candidates = {
    client: [{ id: 3, name: 'Acme' }],
    owner: [{ id: 7, name: 'Ana Reed', email: 'ana@local.test' }],
    project: [{ id: 5, name: 'Launch', client_id: 3, client_name: 'Acme' }],
  };
  let beforeSave = async () => {};
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: req.method, body });
    function reply(code, data) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    if (redirect) {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
      return res.end();
    }
    if (failure) {
      res.writeHead(failure, { 'Retry-After': '60' });
      return res.end('test API response');
    }
    if (!req.headers['user-agent'].includes('@')) return reply(401, {});
    if (u.pathname === '/api/v2/roles.json' && req.headers.authorization?.startsWith('Basic '))
      return reply(200, [
        { subscription_id: 42, company: 'Studio', api_token: token },
        { subscription_id: 53, company: 'Agency', api_token: 'alt-secret' },
      ]);
    if (req.headers.authorization !== `Token token=${token}` || !u.pathname.startsWith('/42/api/v2/'))
      return reply(401, {});
    const path = u.pathname.slice('/42/api/v2/'.length, -5);
    if (path === 'me') return reply(me === undefined ? 404 : 200, me);
    if (/^(users|clients|projects|tasks)(\/\d+)?$/.test(path) && ['POST', 'PUT'].includes(req.method))
      return reply(req.method === 'POST' ? 201 : 200, { id: 12, ...Object.values(body)[0] });
    if (path === 'management/lookup') {
      const { kind, name, client_id } = Object.fromEntries(u.searchParams);
      const matches = candidates[kind].filter((item) =>
        (item.name.toLowerCase() === name.toLowerCase() ||
          (kind === 'owner' && (item.email === name || (name === 'me' && item.id === me.id)))) &&
        (!client_id || item.client_id === Number(client_id)));
      return reply(200, matches);
    }
    if (path === 'users') return reply(200, users);
    if (['tasks', 'tasks/recent'].includes(path)) {
      const uid = u.searchParams.get('user_id');
      const pid = u.searchParams.get('project_id');
      const filtered = tasks.filter(
        (task) =>
          !task.date_closed &&
          !task.project?.date_closed &&
          (!uid || task.assigned !== false) &&
          (!pid || Number(pid) === task.project_id)
      );
      const start = (Number(u.searchParams.get('page') ?? 1) - 1) * 100;
      return reply(200, filtered.slice(start, start + 100));
    }
    if (/^tasks\/\d+$/.test(path)) {
      const task = tasks.find((x) => x.id === Number(path.split('/')[1]));
      return task ? reply(200, task) : reply(404, {});
    }
    if (path === 'entries/this_week') return reply(200, entries);
    if (path === 'entries' && req.method === 'GET') {
      const start = (Number(u.searchParams.get('page') ?? 1) - 1) * 100;
      return reply(200, entries.slice(start, start + 100));
    }
    if (path === 'entries' && req.method === 'POST') {
      const e = { ...body.entry, id: entries.length + 10 };
      entries.push(e);
      return reply(201, e);
    }
    if (path === 'entries/4' && req.method === 'GET') return reply(200, entries[0]);
    if (path === 'entries/4' && req.method === 'PUT') {
      Object.assign(entries[0], body.entry);
      return reply(200, entries[0]);
    }
    if (path === 'timers/2' && timer) {
      if (req.method === 'PUT') Object.assign(timer, body.timer);
      return reply(200, timer);
    }
    if (path === 'timers' && req.method === 'POST') {
      timer = { ...body.timer, id: 2, last_started_at: '2026-11-24T09:00:00Z' };
      return reply(201, timer);
    }
    if (path === 'timers/2/pause' && timer) {
      timer.last_started_at = null;
      return reply(200, timer);
    }
    if (path === 'timers/2/start' && timer) {
      timer.last_started_at = '2026-11-24T10:00:00Z';
      return reply(200, timer);
    }
    if (path === 'entries/create_from_timer' && timer) {
      await beforeSave(req, res);
      if (res.destroyed) return;
      timer = null;
      return reply(201, { id: 22, task_id: 9, hours: 0.5 });
    }
    return reply(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { force: true, recursive: true });
  });
  const env = {
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    TICK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    TICK_API_TOKEN: token,
    TICK_SUBSCRIPTION_ID: '42',
  };
  const invoke = (...args) => cli(env, [...args, '--json']);
  const call = (name, body) => cli(env, ['call', name, '--json'], JSON.stringify(body));
  return {
    dir,
    calls,
    candidates,
    entries,
    tasks,
    users,
    env,
    invoke,
    call,
    setMe: (user) => { me = user; },
    beforeSave: (fn) => {
      beforeSave = fn;
    },
    redirect: () => (redirect = true),
    fail: (n) => (failure = n),
  };
}
function ok(r) {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function bad(r) {
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
  return JSON.parse(r.stderr).error;
}

test('the agent catalog and help are available without credentials', async () => {
  const tools = ok(await cli({}, ['tools', '--json']));
  assert.ok(tools.length >= 20);
  for (const item of tools) {
    assert.match(item.name, /^[a-z_]+$/);
    assert.equal(item.inputSchema.additionalProperties, false);
    assert.equal(typeof item.annotations.readOnlyHint, 'boolean');
  }
  assert.ok(!tools.some((o) => o.name === 'login'));
  const { stdout } = await cli({}, ['log', '--help']);
  assert.match(stdout, /--task-id/);
  assert.match(stdout, /--dry-run/);
});
test('CLI and MCP resolve task durations and write the same API shape', async (t) => {
  const f = await fixture(t);
  const e = ok(await f.invoke('log', '1h30m', '--task-id', '9', '--notes', 'Design', '--date', '2026-11-24'));
  assert.equal(e.hours, 1.5);
  assert.equal(e.user_id, 7);
  const r = ok(await f.call('log_time', { task_id: 9, duration: '45m', date: '2026-11-24' }));
  assert.equal(r.hours, 0.75);
  const response = ok(await f.invoke('week'));
  assert.equal(response.total_hours, 2.75);
  assert.equal(response.days[0].hours, 2.75);
  const summary = ok(await f.invoke('tasks', 'budget', '9'));
  assert.equal(summary.budget_remaining, -1.25);
  f.tasks[0].budget = null;
  assert.equal(ok(await f.call('get_task_budget', { task_id: 9 })).budget_remaining, null);
  const dry = ok(await f.invoke('log', '1.25', '--task-id', '9', '--dry-run'));
  assert.deepEqual(dry.body, { entry: { task_id: 9, hours: 1.25 } });
  assert.equal(f.calls.filter((r) => r.method === 'POST').length, 2);
});
test('update verifies task membership, locked status and entry ownership', async (t) => {
  const f = await fixture(t);
  assert.equal(ok(await f.invoke('entries', 'update', '4', '--notes', 'amended')).notes, 'amended');
  f.entries[0].user_id = 10;
  assert.equal(bad(await f.call('update_entry', { entry_id: 4, notes: 'other' })).code, 'forbidden');
  f.entries[0].user_id = 7;
  f.entries[0].locked = true;
  assert.equal(bad(await f.call('update_entry', { entry_id: 4, notes: 'locked' })).code, 'forbidden');
  assert.equal(bad(await f.call('log_time', { task_id: 999, duration: '1h' })).status, 404);
  assert.equal(f.calls.filter((r) => r.method !== 'GET').length, 1);
});
test('machine input and date filters are validated before a request', async (t) => {
  const f = await fixture(t);
  for (const data of [
    { updated_at: '2026-11-24' },
    { start_date: '2026-02-30', end_date: '2026-03-01' },
    { start_date: '2026-11-25', end_date: '2026-11-24' },
    { start_date: '2026-11-01' },
    { page: 1, api_token: 'x' },
    { page: '2' },
  ])
    assert.equal(bad(await f.call('list_entries', data)).code, 'invalid_input');
  assert.equal(bad(await f.call('log_time', { task_id: 9, duration: '25h' })).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
  ok(
    await f.invoke(
      'entries',
      'list',
      '--start-date',
      '2026-11-01',
      '--end-date',
      '2026-11-24',
      '--billable',
      'false',
      '--page',
      '3'
    )
  );
  assert.deepEqual(f.calls.at(-1).query, {
    start_date: '2026-11-01',
    end_date: '2026-11-24',
    billable: 'false',
    page: '3',
  });
});
test('timer start, pause, resume, save are distinct; saving twice cannot replay a write', async (t) => {
  const f = await fixture(t);
  assert.equal(ok(await f.invoke('timers', 'start', '9')).task_id, 9);
  assert.equal(ok(await f.invoke('timers', 'pause', '2')).last_started_at, null);
  ok(await f.invoke('timers', 'pause', '2'));
  assert.ok(ok(await f.invoke('timers', 'resume', '2')).last_started_at);
  assert.equal(ok(await f.invoke('timers', 'save', '2')).id, 22);
  assert.equal(bad(await f.invoke('timers', 'save', '2')).status, 404);
  assert.deepEqual(
    f.calls.filter((x) => x.method !== 'GET').map((x) => x.path.split('/api/v2/')[1]),
    ['timers.json', 'timers/2/pause.json', 'timers/2/start.json', 'entries/create_from_timer.json']
  );
});
test('timer start accepts an optional positional task, task flag or notes alone', async (t) => {
  const f = await fixture(t);
  const start = ok(await f.invoke('tools')).find((tool) => tool.name === 'start_timer');
  assert.deepEqual(start.inputSchema.required, []);
  assert.match((await cli({}, ['timers', 'start', '--help'])).stdout, /tick timers start \[task_id\]/);
  assert.deepEqual(ok(await f.invoke('timers', 'start', '--dry-run')).body, { timer: { task_id: null } });
  assert.deepEqual(ok(await f.invoke('timers', 'start', '--task-id', '9', '--dry-run')).body, {
    timer: { task_id: 9 },
  });
  assert.equal(f.calls.length, 0);
  assert.equal(ok(await f.invoke('timers', 'start')).task_id, null);
  assert.equal(ok(await f.call('start_timer', { notes: 'Planning' })).notes, 'Planning');
  assert.deepEqual(f.calls.map(({ method, body }) => [method, body]), [
    ['POST', { timer: { task_id: null } }],
    ['POST', { timer: { task_id: null, notes: 'Planning' } }],
  ]);
});
test('an unassigned timer can pause and resume, then be assigned and saved', async (t) => {
  const f = await fixture(t);
  ok(await f.invoke('timers', 'start', '--notes', 'Planning'));
  assert.equal(ok(await f.invoke('timers', 'pause', '2')).last_started_at, null);
  assert.ok(ok(await f.invoke('timers', 'resume', '2')).last_started_at);
  assert.match(bad(await f.invoke('timers', 'save', '2')).message, /tick timers update 2 --task-id/);
  assert.ok(f.calls.every(({ path }) => path.includes('/timers')));
  assert.equal(ok(await f.invoke('timers', 'update', '2', '--task-id', '9')).notes, 'Planning');
  assert.equal(ok(await f.invoke('timers', 'save', '2')).task_id, 9);
});
test('taskless start and resume reject a mismatched configured user before writing', async (t) => {
  const f = await fixture(t);
  ok(await f.invoke('timers', 'start'));
  ok(await f.invoke('timers', 'pause', '2'));
  const before = f.calls.length;
  f.env.TICK_USER_ID = '8';
  for (const args of [['start'], ['resume', '2']]) {
    const error = bad(await f.invoke('timers', ...args));
    assert.equal(error.code, 'configuration');
    assert.match(error.message, /configured user ID/);
  }
  assert.ok(f.calls.slice(before).every(({ method }) => method === 'GET'));
});
test('login selects an account, scopes the saved credential and never prints role tokens', async (t) => {
  const f = await fixture(t);
  const env = { XDG_CONFIG_HOME: f.dir, TICK_BASE_URL: f.env.TICK_BASE_URL };
  const args = ['login', '--email', 'ana@local.test', '--password-stdin', '--json'];
  const missing = bad(await cli(env, args, 'test-password'));
  assert.equal(missing.code, 'select_account');
  assert.equal(missing.accounts.length, 2);
  assert.doesNotMatch(JSON.stringify(missing), /fixture-token|alt-secret|test-password/);
  assert.deepEqual(ok(await cli(env, [...args, '--subscription-id', '42'], 'test-password')), {
    subscription_id: 42, user_id: 7, company: 'Studio', signed_in: true,
  });
  const file = join(f.dir, 'tick', 'account.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, 'utf8'), /test-password/);
  assert.equal(ok(await cli(env, ['account', '--json'])).subscription_id, 42);
  const wrong = bad(await cli({ ...env, TICK_BASE_URL: 'https://elsewhere.test' }, ['account', '--json']));
  assert.equal(wrong.code, 'configuration');
  ok(await cli(env, ['logout', '--json']));
  assert.equal(bad(await cli(env, ['account', '--json'])).code, 'configuration');
});
test('token login uses the current identity in the greeting and handles older servers', async (t) => {
  const f = await fixture(t);
  const env = { XDG_CONFIG_HOME: f.dir, TICK_BASE_URL: f.env.TICK_BASE_URL };
  const args = ['login', '--subscription-id', '42', '--token-stdin'];
  f.setMe({ id: 7, company: 'North\nStudio', email: 'ana@local.test' });
  const result = await cli(env, args, token);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'You are now logged into the North Studio account as ana@local.test.\n');
  assert.deepEqual(ok(await cli(env, [...args, '--json'], token)), {
    subscription_id: 42, user_id: 7, signed_in: true,
  });
  assert.doesNotMatch(await readFile(join(f.dir, 'tick', 'account.json'), 'utf8'), /Studio|ana@/);
  f.setMe({ id: 7 });
  const legacy = await cli(env, args, token);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(legacy.stdout, 'You are now logged into Tick.\n');
});
test('older servers with ambiguous admin identity, HTTPS errors and redirects fail closed', async (t) => {
  const f = await fixture(t);
  f.users.push({ id: 8, first_name: 'Sam' });
  f.entries.length = 0;
  f.setMe(undefined);
  assert.equal(bad(await f.call('log_time', { task_id: 9, duration: '1h' })).code, 'identity_required');
  assert.equal(
    bad(await cli({ ...f.env, TICK_BASE_URL: 'http://example.org' }, ['users', 'list', '--json'])).code,
    'invalid_input'
  );
  f.redirect();
  assert.equal(bad(await f.invoke('timers', 'list')).code, 'network_error');
});
test('rate limit errors carry retry details without automatic replay', async (t) => {
  const f = await fixture(t);
  f.fail(429);
  const e = bad(await f.invoke('timers', 'start', '9'));
  assert.equal(e.retry_after, '60');
  assert.equal(e.status, 429);
  assert.equal(f.calls.length, 1);
});

test('report totals complete pages and preserves the four-decimal entry precision', async (t) => {
  const f = await fixture(t);
  f.entries.length = 0;
  for (let id = 1; id <= 101; id++)
    f.entries.push({ id, task_id: (id % 2) + 1, hours: 0.0001, date: '2026-11-24' });
  const result = ok(
    await f.invoke('report', '--start-date', '2026-11-01', '--end-date', '2026-11-24', '--group-by', 'task')
  );
  assert.equal(result.total_hours, 0.0101);
  assert.deepEqual(result.groups, [
    { task_id: 1, hours: 0.005, entry_count: 50 },
    { task_id: 2, hours: 0.0051, entry_count: 51 },
  ]);
  assert.deepEqual(
    f.calls.map((r) => r.query.page),
    ['1', '2']
  );
  f.entries[100].id = 1;
  assert.equal(
    bad(await f.call('summarize_time', { start_date: '2026-11-01', end_date: '2026-11-24' })).code,
    'report_changed'
  );
});
test('the authenticated token owner can log the first entry of the week', async (t) => {
  const f = await fixture(t);
  f.users.push({ id: 8, first_name: 'Sam', last_name: 'Gray' });
  f.entries.length = 0;
  const env = { ...f.env, TICK_USER_ID: '8' };
  const args = ['call', 'log_time', '--json'];
  const input = JSON.stringify({ task_id: 9, duration: '45m' });
  assert.equal(bad(await cli(env, args, input)).code, 'configuration');
  assert.ok(!f.calls.some((c) => c.method === 'POST'));

  const result = ok(await cli({ ...env, TICK_USER_ID: '7' }, args, input));
  assert.equal(result.user_id, 7);
  assert.equal(result.hours, 0.75);
  assert.ok(!f.calls.some((c) => /users|entries\/this_week/.test(c.path)));
  const account = ok(await f.invoke('account'));
  assert.equal(account.user_name, 'Ana Reed');

  f.setMe({ id: null });
  assert.equal(bad(await cli(env, args, input)).code, 'invalid_response');
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
});
test('an older server can verify a saved email login for an empty week', async (t) => {
  const f = await fixture(t);
  f.setMe(undefined);
  f.users.push({ id: 8, first_name: 'Sam', email: 'sam@local.test' });
  f.entries.length = 0;
  const profile = { XDG_CONFIG_HOME: f.dir, TICK_BASE_URL: f.env.TICK_BASE_URL };
  const result = await cli(profile, ['login', '--email', 'ana@local.test', '--subscription-id', '42', '--password-stdin'], 'password');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'You are now logged into the Studio account as ana@local.test.\n');
  const args = ['call', 'log_time', '--json'];
  const input = JSON.stringify({ task_id: 9, duration: '45m' });
  assert.equal(bad(await cli({ ...f.env, TICK_USER_ID: '8' }, args, input)).code, 'identity_required');
  assert.equal(ok(await cli(profile, args, input)).user_id, 7);
});
test('MCP session binding rejects changed accounts before contacting Tick', async (t) => {
  const f = await fixture(t);
  const getBinding = async (env) => ok(await cli(env, ['session', '--json']));
  const { binding } = await getBinding(f.env);
  assert.match(binding, /^[0-9a-f]{64}$/);
  assert.deepEqual(await getBinding(f.env), { binding });
  const pinned = { ...f.env, TICK_EXPECTED_SESSION: binding };
  ok(await cli(pinned, ['call', 'list_users', '--json'], '{}'));
  const before = f.calls.length;
  for (const overrides of [
    { TICK_SUBSCRIPTION_ID: '41' },
    { TICK_API_TOKEN: 'different-token' },
    { TICK_USER_ID: '7' },
    { TICK_BASE_URL: 'https://elsewhere.test' },
    { TICK_API_TOKEN: '' },
  ]) {
    const err = bad(
      await cli({ ...pinned, ...overrides }, ['call', 'start_timer', '--json'], '{"task_id":9}')
    );
    assert.equal(err.code, 'session_changed');
    assert.doesNotMatch(JSON.stringify(err), /fixture-token|different-token/);
  }
  assert.equal(f.calls.length, before);
  const profile = { XDG_CONFIG_HOME: f.dir, TICK_BASE_URL: f.env.TICK_BASE_URL };
  ok(await cli(profile, ['login', '--subscription-id', '42', '--token-stdin', '--json'], token));
  const saved = (await getBinding(profile)).binding;
  ok(await cli(profile, ['logout', '--json']));
  assert.equal(
    bad(await cli({ ...profile, TICK_EXPECTED_SESSION: saved }, ['call', 'list_users', '--json'], '{}')).code,
    'session_changed'
  );
});
test('timer writes require an open assigned task and let the user correct a stale target', async (t) => {
  const f = await fixture(t);
  f.users.push({ id: 8, first_name: 'Sam' });
  f.tasks.push(
    { id: 10, name: 'Closed task', project_id: 5, date_closed: '2020-01-01' },
    { id: 11, name: 'Closed project', project_id: 6, project: { date_closed: '2020-01-01' } },
    { id: 12, name: 'Visible to admin only', project_id: 7, assigned: false }
  );
  for (const task_id of [10, 11, 12]) {
    assert.equal(bad(await f.call('start_timer', { task_id })).code, 'task_unavailable');
    assert.equal(bad(await f.call('update_timer', { timer_id: 2, task_id })).code, 'task_unavailable');
  }
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.ok(
    f.calls.some(
      (c) => c.path.endsWith('/tasks.json') && c.query.user_id === '7' && c.query.project_id === '7'
    )
  );
  f.tasks[0].assigned = false;
  assert.equal(bad(await f.invoke('timers', 'resume', '2')).code, 'task_unavailable');
  f.tasks.push({ id: 13, name: 'Available', project_id: 5 });
  assert.equal(ok(await f.invoke('timers', 'update', '2', '--task-id', '13')).task_id, 13);
  assert.ok(ok(await f.invoke('timers', 'resume', '2')).last_started_at);
});

test('two concurrent CLI processes issue one timer conversion', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let entered, release;
  const writing = new Promise((resolve) => (entered = resolve));
  const wait = new Promise((resolve) => (release = resolve));
  f.beforeSave(async () => {
    entered();
    await wait;
  });
  const first = f.invoke('timers', 'save', '2');
  let error;
  try {
    await writing;
    error = bad(await f.invoke('timers', 'save', '2'));
  } finally {
    release();
  }
  assert.equal(ok(await first).id, 22);
  assert.equal(error.code, 'timer_save_locked');
  assert.equal(f.calls.filter((c) => c.path.endsWith('create_from_timer.json')).length, 1);
  await assert.rejects(stat(error.lock_directory), { code: 'ENOENT' });
});

test('an indeterminate timer conversion retains a marker across invocations', async (t) => {
  const f = await fixture(t);
  f.beforeSave(async (_req, res) => res.destroy());
  const first = bad(await f.invoke('timers', 'save', '2'));
  assert.equal(first.code, 'timer_save_uncertain');
  assert.ok((await stat(first.lock_directory)).isDirectory());
  assert.equal(bad(await f.invoke('timers', 'save', '2')).code, 'timer_save_locked');
  assert.equal(f.calls.filter((c) => c.path.endsWith('create_from_timer.json')).length, 1);
});

test('terminal and JSON account commands send only supplied fields under the resource key', async (t) => {
  const f = await fixture(t);
  const scenarios = [
    ['user', { first_name: 'Jo', last_name: 'Park', email: 'jo@example.test' }, { admin: false, billable_rate: 0 }],
    ['client', { name: 'Studio' }, { archive: false }],
    ['project', { client_id: 3, owner_id: 7, name: 'Launch' }, { budget: 0, recurring: false }],
    ['task', { project_id: 5, name: 'Design', budget: 1.5 }, { billable: false, date_closed: '2026-12-01' }],
  ];
  for (const [resource, create, update] of scenarios) {
    const plural = resource + 's';
    const flags = Object.entries(create).flatMap(([k, v]) => ['--' + k.replaceAll('_', '-'), String(v)]);
    const created = await cli(f.env, [plural, 'create', ...flags]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /id: 12/);
    assert.deepEqual(f.calls.at(-1), {
      path: '/42/api/v2/' + plural + '.json', method: 'POST', query: {}, body: { [resource]: create },
    });
    assert.deepEqual(ok(await f.call('update_' + resource, { [resource + '_id']: 12, ...update })), {
      id: 12, ...update,
    });
    assert.deepEqual(f.calls.at(-1), {
      path: '/42/api/v2/' + plural + '/12.json', method: 'PUT', query: {}, body: { [resource]: update },
    });
  }
});
test('account write previews stay offline, and invalid edits and mismatched token owners cannot write', async (t) => {
  const f = await fixture(t);
  f.env.TICK_USER_ID = '99';
  const dry = ok(await f.invoke('tasks', 'update', '12', '--budget', '2.75', '--dry-run'));
  assert.deepEqual(dry, {
    dry_run: true, path: '/42/api/v2/tasks/12.json', method: 'PUT', body: { task: { budget: 2.75 } },
  });
  for (const [name, data] of [
    ['create_project', { name: 'Launch', client_id: 3 }],
    ['update_user', { user_id: 12, email: 'jo@example.test' }],
    ['update_user', { user_id: 12, password: 'unused' }],
    ['update_client', { client_id: 12 }],
    ['update_task', { task_id: 12, budget: -1 }],
    ['update_task', { task_id: 12, due_date: '2026-12-01' }],
    ['update_project', { project_id: 12, budget: '2' }],
  ]) assert.equal(bad(await f.call(name, data)).code, 'invalid_input');
  assert.equal(bad(await f.invoke('tasks', 'update', '12', '--budget', '')).code, 'invalid_input');
  assert.equal(bad(await f.invoke('tasks', 'create', '--name', 'Design', '--project-id', '5', '--due-date', '2026-12-01')).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
  assert.equal(bad(await f.invoke('clients', 'update', '12', '--name', 'Studio')).code, 'configuration');
  assert.deepEqual(f.calls.map((call) => call.method), ['GET']);
});

test('account add and edit aliases preview the same requests as create and update', async (t) => {
  const f = await fixture(t);
  const examples = [
    ['users', ['--first-name', 'Jo', '--last-name', 'Park', '--email', 'jo@example.test'], ['--admin', 'false']],
    ['clients', ['--name', 'Studio'], ['--archive', 'false']],
    ['projects', ['--client-id', '3', '--owner-id', '7', '--name', 'Launch'], ['--budget', '1.5']],
    ['tasks', ['--project-id', '5', '--name', 'Design'], ['--billable', 'true']],
  ];
  for (const [resource, add, edit] of examples) {
    for (const [alias, verb, args] of [['add', 'create', add], ['edit', 'update', ['12', ...edit]]]) {
      const preview = ok(await f.invoke(resource, alias, ...args, '--dry-run'));
      assert.deepEqual(preview, ok(await f.invoke(resource, verb, ...args, '--dry-run')));
    }
  }
  assert.equal(bad(await f.invoke('entries', 'edit', '12', '--notes', 'draft', '--dry-run')).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
});

test('hourly rates must fit the subscription billable rate in cents', async (t) => {
  const f = await fixture(t);
  const preview = ok(await f.invoke('users', 'edit', '12', '--billable-rate', '21474836.47', '--dry-run'));
  assert.equal(preview.body.user.billable_rate, 21474836.47);
  assert.equal(bad(await f.call('update_user', { user_id: 12, billable_rate: 21474836.48 })).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
});

test('named selectors resolve to scoped IDs on terminal and JSON commands', async (t) => {
  const f = await fixture(t);
  const create = ok(await f.invoke('projects', 'add', '--name', 'Launch', '--client', 'ACME', '--owner', 'me', '--dry-run'));
  assert.deepEqual(create.body, { project: { client_id: 3, owner_id: 7, name: 'Launch' } });
  assert.deepEqual(f.calls.map((c) => [c.method, c.query]), [
    ['GET', { kind: 'client', name: 'ACME' }], ['GET', { kind: 'owner', name: 'me' }],
  ]);
  ok(await f.call('update_project', { project: 'Launch', client: 'Acme', owner: 'ana@local.test', name: 'Website' }));
  assert.deepEqual(f.calls.slice(-3).map((c) => c.query), [
    { kind: 'project', name: 'Launch', client_id: '3' }, { kind: 'owner', name: 'ana@local.test' }, {},
  ]);
  assert.deepEqual(f.calls.at(-1), {
    method: 'PUT', path: '/42/api/v2/projects/5.json', query: {}, body: { project: { owner_id: 7, name: 'Website' } },
  });
  ok(await f.call('update_project', { project_id: 5, client: 'Acme' }));
  assert.deepEqual(f.calls.at(-1).body, { project: { client_id: 3 } });
  ok(await f.invoke('clients', 'edit', '--client', 'Acme', '--name', 'New'));
  assert.equal(f.calls.at(-1).path, '/42/api/v2/clients/3.json');
  f.candidates.project.push({ id: 6, name: 'Launch', client_id: 4, client_name: 'Beta' });
  ok(await f.call('create_task', { name: 'Test', project: 'Launch', client_id: 4 }));
  assert.deepEqual(f.calls.at(-1).body, { task: { name: 'Test', project_id: 6 } });
  ok(await f.invoke('tasks', 'edit', '9', '--project', 'Launch', '--client', 'Acme'));
  assert.deepEqual(f.calls.at(-1).body, { task: { project_id: 5 } });
});

test('ambiguous, missing or invalid matches and failed lookups stop before a write', async (t) => {
  const f = await fixture(t);
  f.candidates.project.push({ id: 6, name: 'Launch', client_id: 4, client_name: 'Beta' });
  const conflict = bad(await f.invoke('tasks', 'add', '--name', 'Review', '--project', 'Launch'));
  assert.equal(conflict.code, 'ambiguous_match');
  assert.match(conflict.message, /Acme #3.*Beta #4.*--client/);
  for (let i = 0; i < 9; i++)
    f.candidates.project.push({ id: i + 20, name: 'Launch', client_id: 10 + i, client_name: 'Studio ' + i });
  const capped = bad(await f.invoke('tasks', 'add', '--name', 'Review', '--project', 'Launch'));
  assert.match(capped.message, /Showing the first 11 matches/);
  assert.equal(capped.matches.length, 11);
  f.candidates.owner.push({ id: 8, name: 'Ana Reed', email: 'other@local.test' });
  const owner = bad(await f.call('update_project', { project_id: 5, owner: 'Ana Reed' }));
  assert.match(owner.message, /ana@local.test.*7.*other@local.test.*8.*--owner-id/);
  assert.equal(bad(await f.call('update_client', { client: 'Missing', name: 'New' })).code, 'not_found');
  f.candidates.client.push({ id: 0, name: 'Bad' });
  assert.equal(bad(await f.call('update_client', { client: 'Bad', name: 'New' })).code, 'invalid_response');
  f.fail(403);
  assert.equal(bad(await f.call('update_client', { client: 'Acme', name: 'New' })).status, 403);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('conflicting selectors and qualifiers fail before lookup; named previews bind the signed-in user', async (t) => {
  const f = await fixture(t);
  for (const [tool, args] of [
    ['create_project', { name: 'X', client: 'Acme', client_id: 3, owner: 'me' }],
    ['create_project', { name: 'X', client: 'Acme', owner: 'me', owner_id: 7 }],
    ['create_task', { name: 'X', project: 'Launch', project_id: 5 }],
    ['update_project', { project_id: 5, project: 'Launch', name: 'New' }],
    ['update_project', { project: 'Launch', client: 'Acme' }],
    ['update_task', { task_id: 9, project_id: 5, client: 'Acme' }],
    ['update_task', { task_id: 9, client_id: 3, name: 'New' }],
  ]) assert.equal(bad(await f.call(tool, args)).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
  f.env.TICK_USER_ID = '99';
  const result = await f.invoke('clients', 'edit', '--client', 'Acme', '--name', 'New', '--dry-run');
  assert.equal(bad(result).code, 'configuration');
  assert.deepEqual(f.calls.map((c) => c.path), ['/42/api/v2/me.json']);
});

test('repeated management selector flags stop before lookup or write', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['projects', 'add', '--client', 'Acme', '--client', 'Other', '--owner', 'me', '--name', 'X'],
    ['projects', 'edit', '5', '--client=Acme', '--client', 'Other'],
    ['projects', 'edit', '5', '--owner=me', '--owner=Other'],
    ['projects', 'edit', '5', '--owner-id=7', '--owner-id', '8'],
    ['tasks', 'edit', '9', '--project=Launch', '--project', 'Other'],
    ['tasks', 'edit', '9', '--project-id', '5', '--project-id=6'],
    ['tasks', 'edit', '9', '--project', 'Launch', '--client-id=3', '--client-id=4'],
    ['tasks', 'edit', '--task-id=9', '--task-id=10', '--billable=true'],
    ['users', 'edit', '--user-id=7', '--user-id=8', '--admin=false'],
  ]) assert.equal(bad(await f.invoke(...args)).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
  const preview = ok(await f.invoke('clients', 'add', '--name=First', '--name=Last', '--dry-run'));
  assert.equal(preview.body.client.name, 'Last');
});

test('owner selectors accept a full name with two 255-character parts', async (t) => {
  const f = await fixture(t);
  const name = '𠮷'.repeat(255) + ' ' + 'B'.repeat(255);
  f.candidates.owner.push({ id: 11, name, email: 'long@local.test' });
  const preview = ok(await f.invoke('projects', 'edit', '5', '--owner', name, '--dry-run'));
  assert.deepEqual(preview.body.project, { owner_id: 11 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].query.name, name);
});
