#!/usr/bin/env node
import { parseArgs, inspect } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TickError,
  usage,
  loadAccount,
  accountForCall,
  sessionBinding,
  saveAccount,
  forgetAccount,
  origin,
  positiveId,
  request,
  identity,
  api,
} from '../lib/api.js';
import { browserLogin } from '../lib/oauth.js';
import { operations, catalog, validate, execute, hours, requireTimeWriteAccess } from '../lib/operations.js';
import { pickTask, display } from '../lib/task-picker.js';

const argv = process.argv.slice(2);
const json = argv.includes('--json') || argv[0] === 'call';
const globalOptions = {
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};
function show(value) {
  if (json) return console.log(JSON.stringify(value));
  if (value && Array.isArray(value.days) && Array.isArray(value.entries)) {
    console.log(`This week: ${value.total_hours} hours across ${value.entries.length} entries.`);
    for (const day of value.days) console.log(`  ${display(day.date)}  ${day.hours}h`);
    if (value.entries.length) {
      console.log('');
      show(value.entries);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) return console.log('No matching records.');
    const fields = [
      'id',
      'name',
      'first_name',
      'last_name',
      'client_name',
      'project_name',
      'project_id',
      'task_id',
      'date',
      'hours',
      'budget_remaining',
      'last_started_at',
      'accumulated_seconds',
      'notes',
    ].filter((key) => value.some((row) => row && Object.hasOwn(row, key)));
    if (fields.length) {
      const rows = [fields, ...value.map((row) => fields.map((key) => display(row[key])))];
      const widths = fields.map((_, i) => Math.max(...rows.map((row) => row[i].length)));
      for (const row of rows)
        console.log(
          row
            .map((s, i) => s.padEnd(widths[i]))
            .join('  ')
            .trimEnd()
        );
      return;
    }
  }
  console.log(
    inspect(value, { colors: process.stdout.isTTY, depth: null, compact: false, maxArrayLength: null })
  );
}
function parse(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (e) {
    // Parser errors can echo arbitrary argv, including accidentally supplied credentials.
    usage(
      e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
        ? 'Unknown option. Use --help for supported flags.'
        : 'Invalid or missing option value. Use --help.'
    );
  }
}
const flagFor = (k) => k.replaceAll('_', '-');
function commandUsage(op) {
  const arguments_ = op.positional.map((key) =>
    op.inputSchema.required.includes(key) ? `<${key}>` : `[${key}]`
  );
  for (const key of op.inputSchema.required) {
    if (op.positional.includes(key)) continue;
    const flag = `--${flagFor(key)} <value>`;
    arguments_.push(op.name === 'log_time' && key === 'task_id' ? `[${flag}]` : flag);
  }
  for (const rule of op.inputSchema.allOf ?? []) {
    const keys = rule.not?.required ?? rule.oneOf.map((branch) => branch.required[0]);
    const options = keys.map((k) => op.positional.includes(k) ? `<${k}>` : `--${flagFor(k)} <value>`);
    const group = rule.oneOf ? `(${options.join(' | ')})` : `[${options.join(' | ')}]`;
    const position = op.positional.indexOf(keys[0]);
    if (position < 0) arguments_.push(group);
    else arguments_[position] = group;
  }
  return [op.command, ...arguments_].join(' ');
}
const wordmark = [
  '████████  ██   ▄██████  ██  ▄██',
  '   ██     ██  ██▀       ██▄██▀',
  '   ██     ██  ██        ████',
  '   ██     ██  ██▄       ██▀██▄',
  '   ██     ██   ▀██████  ██  ▀██',
];

async function printWordmark(output, animate = false) {
  if (json || !process.stdin.isTTY || !process.stdout.isTTY || !output.isTTY) return;
  if (process.env.CI || process.env.TERM === 'dumb') return;
  if (output.columns > 0 && output.columns < wordmark[0].length) return;

  const color = !Object.hasOwn(process.env, 'NO_COLOR') && output.hasColors();
  for (const [index, line] of wordmark.entries()) {
    if (animate && index > 0) await delay(40);
    output.write((color ? `\x1b[1;32m${line}\x1b[0m` : line) + '\n');
  }
  output.write('\n');
}

function usageText(selection = operations) {
  return [
    'Tick time tracking',
    '',
    ...selection.map((op) => `  tick ${commandUsage(op)}`),
    '',
    '  tick login [--allow-writes] [--no-browser]',
    '  tick login --subscription-id ID [--token-stdin]',
    '  tick login --email EMAIL [--subscription-id ID] [--password-stdin]',
    '  tick logout',
    '  tick tools --json',
    '  tick call TOOL_NAME --json  (JSON input on stdin)',
    '',
    'Use --help after a command for its filters. --json returns structured data. --dry-run previews a write.',
  ].join('\n');
}
function helpFor(op) {
  return [
    `tick ${commandUsage(op)}`,
    op.description,
    ...(op.inputSchema.dependentRequired ? ['--client and --client-id qualify --project.'] : []),
    ...(op.name === 'log_time' ? ['Omit --task-id in a terminal to choose a task. Scripts and --json require a task ID.'] : []),
    '',
    ...Object.entries(op.inputSchema.properties).map(
      ([k, p]) => `  --${flagFor(k)} <${p.enum?.join('|') || p.type}>  ${p.description ?? p.format ?? ''}`
    ),
    '',
    op.annotations.readOnlyHint ? '  --json' : '  --json  --dry-run',
  ].join('\n');
}
async function stdin(limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) usage('Input exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function secret(name, fromStdin) {
  if (fromStdin) {
    if (process.stdin.isTTY) usage('Pipe the secret from a password manager or use the interactive prompt.');
    return (await stdin(16384)).replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    usage(`Use --${name}-stdin to supply the ${name} noninteractively.`);
  const silent = new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stderr.write(`Tick ${name}: `);
  try {
    return await prompt.question('');
  } finally {
    prompt.close();
    process.stderr.write('\n');
  }
}
function showLogin(result, company, email) {
  if (json) return show(result);
  const name = typeof company === 'string' && display(company).trim();
  const address = typeof email === 'string' && display(email).trim();
  const account = name ? `the ${name} account` : 'Tick';
  console.log(`You are now logged into ${account}${address ? ' as ' + address : ''}.`);
}

async function login(args) {
  const options = {
    'no-browser': { type: 'boolean' },
    'allow-writes': { type: 'boolean' },
    'subscription-id': { type: 'string' },
    email: { type: 'string' },
    'token-stdin': { type: 'boolean' },
    'password-stdin': { type: 'boolean' },
    json: globalOptions.json,
    help: globalOptions.help,
  };
  const { values: v, positionals } = parse(args, options);
  if (v.help) return console.log(usageText([]));
  if (positionals.length)
    usage('Login accepts named options. Use stdin or the hidden prompt for credentials.');
  if ((v.email && v['token-stdin']) || (!v.email && v['password-stdin']))
    usage('Use --email for password login, or --subscription-id for token login.');
  const base = origin(process.env.TICK_BASE_URL);
  const legacy = v.email || v['subscription-id'] || v['token-stdin'] || v['password-stdin'];
  if (legacy && (v['no-browser'] || v['allow-writes']))
    usage('--no-browser and --allow-writes apply to browser login.');
  if (!legacy) {
    await printWordmark(process.stderr, true);
    const { account, company, email } = await browserLogin(base, {
      noBrowser: v['no-browser'], allowWrites: v['allow-writes'],
    });
    await saveAccount(account);
    return showLogin(
      { signed_in: true, subscription_id: account.subscriptionId, user_id: account.userId, scope: account.scope },
      company,
      email
    );
  }
  let sub = v['subscription-id'] ? positiveId(v['subscription-id'], 'subscription id') : undefined;
  let token, company;
  if (v.email) {
    const pwd = await secret('password', v['password-stdin']);
    if (!pwd) usage('Provide a Tick password.');
    const roles = await request(
      new URL('/api/v2/roles.json', base),
      'Basic ' + Buffer.from(v.email + ':' + pwd).toString('base64')
    );
    const role = sub
      ? roles.find((r) => Number(r.subscription_id) === sub)
      : roles.length === 1
        ? roles[0]
        : null;
    if (!role)
      throw new TickError(
        'select_account',
        'Choose a subscription with --subscription-id and run login again.',
        { accounts: roles.map(({ subscription_id, company }) => ({ subscription_id, company })) }
      );
    sub = positiveId(role.subscription_id, 'subscription id');
    token = role.api_token;
    company = role.company;
  } else {
    if (!sub) usage('Token login requires --subscription-id.');
    token = await secret('token', v['token-stdin']);
  }
  if (typeof token !== 'string' || !token.trim() || /[\s\x00-\x1f\x7f]/.test(token))
    usage('Invalid API token.');
  const account = { subscriptionId: sub, token, origin: base };
  if (v.email) account.verifiedEmail = v.email.toLowerCase();
  const user = await identity(account, api(account));
  if (user) account.userId = positiveId(user.id, 'user id');
  await saveAccount(account);
  showLogin(
    { subscription_id: sub, user_id: account.userId ?? null, ...(company && { company }), signed_in: true },
    user?.company || company,
    user?.email || v.email
  );
}
async function main() {
  if (argv.length === 1 && ['--version', 'version'].includes(argv[0])) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
    return console.log(version);
  }
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    await printWordmark(process.stdout);
    return console.log(usageText());
  }
  const [first, ...rest] = argv;
  if (first === 'login') return login(rest);
  if (first === 'session') {
    const { values, positionals } = parse(rest, { json: globalOptions.json, help: globalOptions.help });
    if (values.help) return console.log('tick session --json');
    if (positionals.length) usage('Unexpected argument.');
    return show({ binding: sessionBinding(await loadAccount()) });
  }
  if (first === 'logout' || first === 'tools') {
    const { values, positionals } = parse(rest, { json: globalOptions.json, help: globalOptions.help });
    if (positionals.length) usage('Unexpected argument.');
    if (values.help) return console.log(first === 'tools' ? 'tick tools --json' : 'tick logout [--json]');
    if (first === 'tools')
      return json
        ? show(catalog())
        : console.log(operations.map((op) => `${op.name}  ${op.description}`).join('\n'));
    const revoked = await forgetAccount();
    return show({ local_credentials_removed: true, ...(revoked && { connection_revoked: true }) });
  }
  let op, inputs, dryRun;
  if (first === 'call') {
    if (!rest[0] || rest[0] === '--help') return console.log('tick call TOOL_NAME --json < input.json');
    op = operations.find((op) => op.name === rest[0]);
    if (!op) usage('Unknown tool. Run tick tools --json.');
    const parsed = parse(rest.slice(1), globalOptions);
    if (parsed.values.help) return console.log(helpFor(op));
    if (parsed.positionals.length) usage('tick call reads its JSON object from stdin.');
    if (process.stdin.isTTY) usage('Supply the tool input as a JSON object on stdin.');
    const source = await stdin();
    try {
      inputs = JSON.parse(source);
    } catch {
      usage('Invalid JSON input. Supply a JSON object on stdin.');
    }
    dryRun = Boolean(parsed.values['dry-run']);
  } else {
    const group = operations.filter((op) => op.command.split(' ')[0] === first);
    if (!group.length) usage('Unknown command. Run tick --help.');
    let verb = rest[0];
    if (group.some((op) => op.writeKind === 'account')) {
      if (verb === 'add') verb = 'create';
      if (verb === 'edit') verb = 'update';
    }
    op = group.find((op) => op.command === first || op.command === first + ' ' + verb);
    if (!op) {
      if (!rest.length || ['--help', '-h'].includes(rest[0])) return console.log(usageText(group));
      usage(`Unknown subcommand. Run tick ${first} --help.`);
    }
    const props = op.inputSchema.properties;
    const opts = { ...globalOptions };
    for (const key of Object.keys(props)) {
      const selector = op.writeKind === 'account' && (key.endsWith('_id') || Object.hasOwn(props, key + '_id'));
      opts[flagFor(key)] = { type: 'string', multiple: selector };
    }
    const parsed = parse(op.command === first ? rest : rest.slice(1), opts);
    if (parsed.values.help) return console.log(helpFor(op));
    if (parsed.positionals.length > op.positional.length)
      usage('Unexpected positional argument. See --help.');
    inputs = {};
    for (const [name, p] of Object.entries(props)) {
      const i = op.positional.indexOf(name);
      const arg = i < 0 ? undefined : parsed.positionals[i];
      const option = parsed.values[flagFor(name)];
      if (Array.isArray(option) && option.length > 1) usage(`Specify ${name} once.`);
      const flag = Array.isArray(option) ? option[0] : option;
      if (arg !== undefined && flag !== undefined) usage(`Specify ${name} once.`);
      const value = flag ?? arg;
      if (value === undefined) continue;
      if (p.type === 'boolean' && !['true', 'false'].includes(value)) usage(`${name} must be true or false.`);
      if (p.type === 'number') {
        if (!/^\d+(?:\.\d+)?$/.test(value)) usage(`${name} must be a nonnegative decimal number.`);
        inputs[name] = Number(value);
      } else if (p.type === 'integer') inputs[name] = positiveId(value, name);
      else if (p.type === 'boolean') inputs[name] = value === 'true';
      else inputs[name] = value;
    }
    dryRun = Boolean(parsed.values['dry-run']);
  }
  const interactiveLog =
    first === 'log' && inputs.task_id === undefined && !json &&
    process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;
  if (interactiveLog) {
    validate({ ...op.inputSchema, required: op.inputSchema.required.filter((key) => key !== 'task_id') }, inputs);
    hours(inputs.duration);
  } else {
    validate(op.inputSchema, inputs);
  }
  const account = await accountForCall(process.env.TICK_EXPECTED_SESSION);
  if (interactiveLog) {
    if (!dryRun) requireTimeWriteAccess(account);
    inputs.task_id = await pickTask(account);
    if (inputs.task_id === null) {
      process.stderr.write('Cancelled.\n');
      return;
    }
  }
  show(await execute(op, inputs, account, dryRun));
}
main().catch((error) => {
  const known = error instanceof TickError;
  const info = {
    code: known ? error.code : 'internal_error',
    message: known ? error.message : 'The operation could not be completed.',
    ...(known ? error.details : {}),
  };
  if (json) process.stderr.write(JSON.stringify({ error: info }) + '\n');
  else {
    console.error('tick: ' + display(info.message));
    if (info.accounts)
      for (const a of info.accounts) console.error(`  ${a.subscription_id}  ${display(a.company)}`);
    if (info.lock_directory) console.error('Lock directory: ' + display(info.lock_directory));
    if (info.retry_after) console.error('Retry-After: ' + display(info.retry_after));
  }
  process.exitCode = info.code === 'invalid_input' ? 2 : 1;
});
