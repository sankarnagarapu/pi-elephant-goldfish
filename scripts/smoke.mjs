#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../', import.meta.url));
const hosts = process.argv.slice(2);
if (!hosts.length) hosts.push('pi', 'pi-bolt', 'omp');
assert(hosts.every((host) => ['pi', 'pi-bolt', 'omp'].includes(host)),
  'Usage: node scripts/smoke.mjs [pi pi-bolt omp]');
const timeoutMs = 30_000;
const base = 'SENIOR_ENGINEER_SMOKE_BASE';
const children = new Set();
let interrupted = false;

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function launch(host, args, options) {
  assert(!interrupted, 'Smoke interrupted');
  const child = spawn(host, args, {
    ...options,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function install(host, options) {
  const args = host === 'omp'
    ? ['plugin', 'link', packagePath]
    : ['install', packagePath];
  const child = launch(host, args, options);
  let output = '';
  child.stdout.on('data', (data) => { output = (output + data).slice(-8192); });
  child.stderr.on('data', (data) => { output = (output + data).slice(-8192); });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const timer = setTimeout(() => kill(child), timeoutMs);
  child.stdin.end();
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Native ${args.slice(0, -1).join(' ')} failed (${signal ?? code}): ${output.trim()}`));
      });
    });
  } finally {
    clearTimeout(timer);
    if (children.has(child)) kill(child);
    await closed;
  }
}

function rpc(child) {
  const events = [];
  const listeners = new Set();
  let buffer = '';
  let stderr = '';
  let failure;
  let sequence = 0;
  const wake = () => { for (const listener of listeners) listener(); };
  const fail = (error) => { failure = error; wake(); };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8192); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { fail(new Error(`Non-JSON RPC output: ${line.slice(0, 300)}`)); }
    }
    wake();
  });
  child.once('error', fail);
  child.once('close', (code, signal) => fail(new Error(`Runtime exited (${signal ?? code})`)));
  child.stdin.on('error', fail);

  function waitFor(predicate, start = 0) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
        else resolve(value);
      };
      const check = () => {
        const event = events.slice(start).find(predicate);
        if (event) finish(null, event);
        else if (failure) finish(failure);
      };
      const timer = setTimeout(() => finish(new Error('RPC request timed out')), timeoutMs);
      listeners.add(check);
      check();
    });
  }

  return {
    events,
    waitFor,
    async send(type, fields = {}) {
      const id = `smoke-${++sequence}`;
      const response = waitFor((event) => event.type === 'response' && event.id === id);
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const result = await response;
      assert.equal(result.success, true, `${type}: ${result.error ?? JSON.stringify(result)}`);
      return result;
    },
  };
}

async function smoke(host, root, baseUrl, requests, fixtureErrors) {
  const home = join(root, host, 'home');
  const cwd = join(root, host, 'work');
  const agentDir = join(root, host, 'agent');
  const temp = join(root, host, 'tmp');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    XDG_CONFIG_HOME: join(root, host, 'config'),
    XDG_DATA_HOME: join(root, host, 'data'),
    XDG_CACHE_HOME: join(root, host, 'cache'),
    XDG_STATE_HOME: join(root, host, 'state'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    TERM: 'dumb',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    CI: '1',
  };
  // Do not inherit credentials, proxy settings, NODE_OPTIONS, or user plugin roots.
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  await Promise.all([home, cwd, agentDir, temp, ...Object.entries(env)
    .filter(([key]) => key.startsWith('XDG_')).map(([, path]) => path)]
    .map((path) => mkdir(path, { recursive: true })));
  const provider = {
    baseUrl,
    api: 'openai-completions',
    ...(host === 'omp' ? { auth: 'none' } : { apiKey: 'smoke' }),
    models: [{
      id: 'smoke', name: 'Smoke', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1024,
    }],
  };
  await writeFile(join(agentDir, host === 'omp' ? 'models.yml' : 'models.json'),
    JSON.stringify({ providers: { smoke: provider } }, null, 2));
  const options = { cwd, env };
  await install(host, options);
  // Native installation must enable default discovery. No explicit -e fallback.
  const args = [
    '--mode', 'rpc', '--no-session', '--model', 'smoke/smoke', '--api-key', 'smoke',
    '--system-prompt', base, '--no-tools', '--no-context-files',
    ...(host === 'omp'
      ? ['--profile', 'default', '--no-lsp', '--no-rules', '--no-title']
      : ['--no-prompt-templates', '--no-themes']),
  ];
  const child = launch(host, args, options);
  const closed = new Promise((resolve) => child.once('close', resolve));
  const client = rpc(child);
  const startRequests = requests.length;
  try {
    const { data } = await client.send(host === 'omp' ? 'get_available_commands' : 'get_commands');
    const commands = data?.commands ?? [];
    assert(commands.some((command) => command.name === 'egm'),
      'Native installation did not discover /pi-elephant-goldfish');
    const skill = commands.some((command) => command.name === 'skill:egm-brainstorm');
    assert(skill, 'Native installation did not discover /skill:egm-brainstorm');

    async function turn(label, enabled) {
      const before = requests.length;
      const start = client.events.length;
      const response = await client.send('prompt', { message: `Smoke transport turn: ${label}` });
      if (host === 'omp') {
        const result = await client.waitFor((event) => event.type === 'prompt_result' && event.id === response.id, start);
        assert.equal(result.status, 'completed', `${label}: provider turn failed`);
        assert.equal(result.agentInvoked, true, `${label}: provider was not invoked`);
        assert.equal(result.sessionSettled, true, `${label}: session did not settle`);
      }
      const end = await client.waitFor((event) => event.type === 'agent_end', start);
      assert.equal(end.willRetry ?? false, false, `${label}: unexpected retry`);
      assert.equal(requests.length, before + 1, `${label}: expected one provider request`);
      const request = requests[before];
      assert.equal(request.model, 'smoke', `${label}: wrong provider model`);
      assert(!request.tools?.length, `${label}: tools were not disabled`);
      const system = request.messages.filter((message) => ['system', 'developer'].includes(message.role))
        .map((message) => typeof message.content === 'string' ? message.content
          : message.content.map((part) => part.text ?? '').join('\n')).join('\n');
      assert(system.includes(base), `${label}: base system prompt was lost`);
      assert.equal((system.match(/^# Elephant-Goldfish Model \(EGM\)\s*$/gm) ?? []).length,
        enabled ? 1 : 0, `${label}: policy missing, duplicated, or still enabled`);
      const assistant = end.messages?.filter((message) => message.role === 'assistant').at(-1);
      assert.equal(assistant?.content?.filter((part) => part.type === 'text')
        .map((part) => part.text).join(''), 'transport-ok', `${label}: fixture response not consumed`);
      assert.equal(fixtureErrors.length, 0, fixtureErrors.join('\n'));
    }

    async function command(action) {
      const before = requests.length;
      await client.send('prompt', { message: `/egm ${action}` });
      const { data: state } = await client.send('get_state');
      assert.equal(state.isStreaming, false, `${action}: command started a model turn`);
      assert.equal(requests.length, before, `${action}: command reached the provider`);
    }

    await turn('default-on', true);
    await turn('second-on', true);
    await command('off');
    await turn('off', false);
    await command('invalid');
    await turn('invalid-stays-off', false);
    await command('on');
    await turn('on-again', true);
    assert.equal(requests.length - startRequests, 5, 'Slash commands made provider requests');
    console.log(`${host}: PASS native install + default discovery; 5 turns, base preserved, policy 1/1/0/0/1, commands local, skill discovered`);
  } finally {
    if (children.has(child)) kill(child);
    await closed;
  }
}

const root = await mkdtemp(join(tmpdir(), 'pi-elephant-goldfish-smoke-'));
const requests = [];
const fixtureErrors = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => ({
      id: 'smoke-completion', object: 'chat.completion.chunk', created: 0, model: 'smoke',
      choices: [{ index: 0, delta, finish_reason }],
    });
    for (const data of [chunk({ role: 'assistant' }), chunk({ content: 'transport-ok' }),
      { ...chunk({}, 'stop'), usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 } }]) {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    fixtureErrors.push(error.message);
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
server.requestTimeout = timeoutMs;
server.headersTimeout = timeoutMs;
const interrupt = () => {
  interrupted = true;
  for (const child of children) kill(child);
  server.closeAllConnections();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  console.log('Loopback SSE fixture only: verifies installation and prompt transport, NOT model quality.');
  for (const host of hosts) {
    try { await smoke(host, root, `http://127.0.0.1:${server.address().port}/v1`, requests, fixtureErrors); }
    catch (error) { process.exitCode = 1; console.error(`${host}: FAIL ${error.message}`); }
    if (interrupted) break;
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const child of children) kill(child);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  if (interrupted) process.exitCode = 1;
}
