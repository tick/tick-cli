import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { TickError, positiveId, request } from './api.js';

const clientId = 'tick-cli';
const failure = (message) => new TickError('oauth_error', message);

async function post(base, path, fields) {
  let response;
  try {
    response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': 'Tick CLI (support@tickspot.com)' },
      body: new URLSearchParams({ client_id: clientId, ...fields }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw failure('Could not reach Tick to complete authorization. Check the API origin and connection.');
  }
  if (!response.ok) {
    const reason = await response.json().catch(() => ({}));
    if (reason?.error === 'invalid_grant') throw failure('Tick authorization expired. Run tick login again.');
    throw failure(`Tick returned HTTP ${response.status} during authorization.`);
  }
  return response;
}

function scopes(value) {
  if (typeof value !== 'string') throw failure('Tick returned an invalid authorization scope.');
  const list = value.split(' ');
  if (!list.includes('read') || list.some((item) => !['read', 'time:write'].includes(item)))
    throw failure('Tick returned an invalid authorization scope.');
  return [...new Set(list)].sort().join(' ');
}

async function tokens(base, fields, scope) {
  const response = await post(base, '/oauth/token', fields);
  const data = await response.json().catch(() => null);
  const validToken = (value) => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
  if (
    data?.token_type?.toLowerCase?.() !== 'bearer' ||
    !validToken(data.access_token) ||
    (data.refresh_token !== undefined && !validToken(data.refresh_token)) ||
    !Number.isSafeInteger(data.expires_in) ||
    data.expires_in < 1 ||
    !Number.isSafeInteger(Date.now() + data.expires_in * 1000)
  )
    throw failure('Tick returned invalid OAuth credentials.');
  const granted = scopes(data.scope === undefined ? scope : data.scope);
  if (granted.split(' ').some((item) => !scope.split(' ').includes(item)))
    throw failure('Tick returned a broader authorization scope than requested.');
  return {
    scope: granted,
    token: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refresh(account) {
  if (!account.refreshToken) throw failure('Tick authorization expired. Run tick login again.');
  const next = await tokens(
    account.origin,
    { grant_type: 'refresh_token', refresh_token: account.refreshToken },
    account.scope
  );
  if (next.scope !== account.scope)
    throw failure('The Tick connection permissions changed. Run tick login again.');
  return { ...account, ...next, refreshToken: next.refreshToken ?? account.refreshToken };
}

export async function revoke(account) {
  await post(account.origin, '/oauth/revoke', {
    token: account.refreshToken || account.token,
    token_type_hint: account.refreshToken ? 'refresh_token' : 'access_token',
  });
}

export async function discardGrant(account, error) {
  try {
    await revoke(account);
  } catch {
    const reason = error instanceof TickError ? error.message : 'Could not save the Tick login.';
    throw failure(reason + ' Tick could not confirm revocation of the newly approved connection.');
  }
}

function openBrowser(url) {
  const [command, ...args] =
    process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler']
      : [process.platform === 'darwin' ? 'open' : 'xdg-open'];
  const child = spawn(command, [...args, url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export async function browserLogin(base, { allowWrites = false, noBrowser = false, timeout = 300_000 } = {}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const scope = allowWrites ? 'read time:write' : 'read';
  const server = createServer();
  let code, redirectUri, timer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }).catch(() => {
      throw failure('Could not open the local browser callback listener.');
    });
    const host = '127.0.0.1:' + server.address().port;
    redirectUri = 'http://' + host + '/callback';
    const auth = new URL('/oauth/authorize', base);
    auth.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope,
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(failure('Browser login timed out. Run tick login again.')), timeout);
      server.on('request', (req, res) => {
        const reply = (status, message) => {
          res.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            Connection: 'close',
          });
          res.end(message);
        };
        const [path, query] = (req.url || '').split(/\?(.*)/s);
        const params = new URLSearchParams(query);
        if (
          req.headers.host !== host ||
          req.method !== 'GET' ||
          path !== '/callback' ||
          params.getAll('state').length !== 1 ||
          params.get('state') !== state
        )
          return reply(400, 'Invalid Tick callback.');
        if (params.has('error')) {
          reply(200, 'Authorization was declined or could not finish. Return to the terminal.');
          return reject(failure('Browser authorization was declined or could not finish.'));
        }
        if (params.getAll('code').length !== 1 || !params.get('code'))
          return reply(400, 'Missing Tick authorization code.');
        reply(200, 'Return to the terminal to finish signing in to Tick.');
        resolve(params.get('code'));
      });
      process.stderr.write('Open this URL in your browser to sign in to Tick:\n' + auth.href + '\n');
      if (!noBrowser) openBrowser(auth.href);
    });
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
  const credentials = await tokens(
    base,
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri },
    scope
  );
  try {
    const me = await request(new URL('/oauth/me', base), 'Bearer ' + credentials.token);
    if (
      !me ||
      scopes(me.scope) !== credentials.scope ||
      !['string', 'number'].includes(typeof me.connection_id) ||
      !String(me.connection_id).trim()
    )
      throw failure('Tick could not verify the selected connection.');
    return {
      company: me.company,
      email: me.email,
      account: {
        authType: 'oauth',
        origin: base,
        sessionId: randomUUID(),
        ...credentials,
        subscriptionId: positiveId(me.subscription_id, 'subscription id'),
        userId: positiveId(me.user_id, 'user id'),
        connectionId: String(me.connection_id),
      },
    };
  } catch (error) {
    await discardGrant({ ...credentials, origin: base }, error);
    throw error;
  }
}
