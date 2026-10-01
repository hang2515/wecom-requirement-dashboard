import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveSummaryConfig } from './src/config.js';
import { createStore } from './src/store.js';
import { summarizeMessage } from './src/summarizer.js';
import { createMessageSource } from './src/wecom.js';
import { fallbackPortFor } from './src/server-port.js';
import { testSummaryConnection } from './src/model-connection.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = { ...await loadConfig(path.join(root, '.env')), workingDirectory: root };
const mediaDirectory = path.join(root, 'data', 'media');
const store = createStore(path.join(root, 'data', 'board.json'));
const source = createMessageSource(config, { mediaDirectory });

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function typeOfMedia(content) {
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

async function readMedia(pathname, response) {
  const fileName = pathname.slice('/media/'.length);
  if (!/^[a-f0-9]{64}\.bin$/.test(fileName)) return json(response, 404, { error: '未找到图片' });
  try {
    const content = await readFile(path.join(mediaDirectory, fileName));
    response.writeHead(200, { 'Content-Type': typeOfMedia(content), 'Cache-Control': 'private, max-age=86400' });
    response.end(content);
  } catch {
    json(response, 404, { error: '未找到图片' });
  }
}

async function readStatic(request, response) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? 'public/index.html' : `public${pathname}`;
  const file = path.resolve(root, requested);
  if (!file.startsWith(`${path.join(root, 'public')}${path.sep}`) && file !== path.join(root, 'public', 'index.html')) return json(response, 403, { error: '禁止访问' });
  try {
    const content = await readFile(file);
    const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
    response.end(content);
  } catch {
    json(response, 404, { error: '未找到资源' });
  }
}

async function enrichMessages(messages) {
  return Promise.all(messages.map(async (message) => {
    const withImages = await source.materializeImages(message);
    return { ...withImages, summary: withImages.text === '收到图片' ? '收到图片' : await summarizeMessage(config.summary, withImages) };
  }));
}

let syncing = false;
async function syncNewMessages() {
  if (syncing || config.source !== 'cli') return;
  if (!config.selfMessageUserId) {
    await store.setListener({ running: true, error: '未设置 WECOM_SELF_MESSAGE_USERID，自动监听不会混入自己发出的消息。可先使用历史补录。' });
    return;
  }
  syncing = true;
  const startedAt = new Date().toISOString();
  try {
    const state = await store.getState();
    const from = state.listener.lastSyncAt ?? startedAt;
    const messages = await source.listHistory(from, startedAt, await store.listWatchUsers());
    const incoming = messages.filter((message) => message.senderUserId !== config.selfMessageUserId);
    const candidates = await store.previewHistory(incoming);
    if (candidates.length) await store.importSelectedMessages(await enrichMessages(candidates));
    await store.setListener({ running: true, lastSyncAt: startedAt, error: null });
  } catch (error) {
    await store.setListener({ running: true, error: error.message || '监听同步失败' });
  } finally {
    syncing = false;
  }
}

if (config.source === 'cli') {
  await store.setListener({ running: true, lastSyncAt: new Date().toISOString(), error: config.selfMessageUserId ? null : '未设置 WECOM_SELF_MESSAGE_USERID，自动监听尚未启用。' });
  setInterval(() => { syncNewMessages(); }, config.pollIntervalMs).unref();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) return readMedia(url.pathname, response);
    if (request.method === 'GET' && url.pathname === '/api/settings/summary') {
      return json(response, 200, { baseUrl: config.summary.baseUrl, model: config.summary.model, apiKeyConfigured: Boolean(config.summary.apiKey) });
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/summary') {
      const submitted = await bodyOf(request);
      const settings = await saveSummaryConfig(path.join(root, '.env'), submitted);
      config.summary = {
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: submitted.apiKey || config.summary.apiKey,
      };
      return json(response, 200, settings);
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/summary/test') {
      const submitted = await bodyOf(request);
      return json(response, 200, await testSummaryConnection({
        baseUrl: submitted.baseUrl,
        model: submitted.model,
        apiKey: submitted.apiKey || config.summary.apiKey,
      }));
    }
    if (request.method === 'GET' && url.pathname === '/api/board') {
      const [pending, completed, watchUsers, connection, listener] = await Promise.all([
        store.listRequirements('pending'), store.listRequirements('completed'), store.listWatchUsers(), source.status(), store.getState(),
      ]);
      return json(response, 200, {
        pending, completed, watchUsers,
        listener: { ...connection, running: listener.listener.running, lastSyncAt: listener.listener.lastSyncAt, error: listener.listener.error },
        summaryConfigured: Boolean(config.summary.apiKey), summaryModel: config.summary.model,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/watch-users/search') {
      return json(response, 200, { users: await source.searchUsers(url.searchParams.get('keyword')) });
    }
    if (request.method === 'POST' && url.pathname === '/api/watch-users') return json(response, 201, await store.addWatchUser(await bodyOf(request)));
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/watch-users/')) {
      await store.removeWatchUser(decodeURIComponent(url.pathname.slice('/api/watch-users/'.length)));
      return json(response, 204, {});
    }
    if (request.method === 'POST' && url.pathname === '/api/requirements/manual') return json(response, 201, await store.addManualRequirement(await bodyOf(request)));
    if (request.method === 'POST' && url.pathname.startsWith('/api/requirements/') && url.pathname.endsWith('/complete')) return json(response, 200, await store.completeRequirement(url.pathname.split('/')[3]));
    if (request.method === 'POST' && url.pathname === '/api/history/preview') {
      const { start, end } = await bodyOf(request);
      const candidates = await store.previewHistory(await source.listHistory(start, end, await store.listWatchUsers()));
      return json(response, 200, { candidates });
    }
    if (request.method === 'POST' && url.pathname === '/api/history/import') {
      const { messages = [] } = await bodyOf(request);
      return json(response, 201, { imported: await store.importSelectedMessages(await enrichMessages(messages)) });
    }
    return readStatic(request, response);
  } catch (error) {
    json(response, 400, { error: error.message || '请求失败' });
  }
});

let activePort = config.port;
server.on('error', (error) => {
  const fallbackPort = fallbackPortFor(error, activePort);
  if (!fallbackPort) throw error;
  activePort = fallbackPort;
  console.log(`端口 ${config.port} 已被占用，需求看板改用：http://127.0.0.1:${activePort}`);
  server.listen(activePort, '127.0.0.1');
});
server.on('listening', () => console.log(`需求看板已启动：http://127.0.0.1:${activePort}`));
server.listen(activePort, '127.0.0.1');
