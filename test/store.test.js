import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStore } from '../src/store.js';
import { createSummaryRequest } from '../src/summarizer.js';
import { cliErrorDetail, createMessageSource, toWeComTime } from '../src/wecom.js';
import { loadConfig, saveSummaryConfig } from '../src/config.js';
import { fallbackPortFor } from '../src/server-port.js';
import { testSummaryConnection } from '../src/model-connection.js';
import { modelStatusHint } from '../public/status.js';
import { toDateTimeLocal } from '../public/time.js';

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecom-board-'));
  try {
    await run(createStore(path.join(directory, 'board.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('adds a manual requirement and keeps it pending', async () => {
  await withStore(async (store) => {
    const requirement = await store.addManualRequirement({
      title: '确认国庆活动页上线时间',
      note: '和运营确认最终时间',
    });

    assert.equal(requirement.status, 'pending');
    assert.equal(requirement.source, 'manual');
    assert.equal((await store.listRequirements('pending')).length, 1);
  });
});

test('completed requirement stays completed when the same message is imported again', async () => {
  await withStore(async (store) => {
    const message = {
      id: 'message-100',
      sender: '刘洋',
      receivedAt: '2026-10-01T09:00:00.000Z',
      text: '确认国庆活动页上线时间',
      summary: '确认国庆活动页上线时间',
      images: [],
    };

    const [first] = await store.importSelectedMessages([message]);
    await store.completeRequirement(first.id);
    await store.importSelectedMessages([message]);

    assert.equal((await store.listRequirements('pending')).length, 0);
    assert.equal((await store.listRequirements('completed')).length, 1);
  });
});

test('history preview excludes messages that have already been imported', async () => {
  await withStore(async (store) => {
    const imported = {
      id: 'message-1', sender: '王倩', receivedAt: '2026-10-01T08:00:00.000Z',
      text: '补一份本周销售数据', summary: '补一份本周销售数据', images: [],
    };
    const candidate = {
      id: 'message-2', sender: '产品群', receivedAt: '2026-10-01T09:00:00.000Z',
      text: '请核对报价单中的运费', summary: '请核对报价单中的运费', images: [],
    };
    await store.importSelectedMessages([imported]);

    const preview = await store.previewHistory([imported, candidate]);
    assert.deepEqual(preview.map((item) => item.id), ['message-2']);
  });
});

test('summary request sends only text and asks for one concise requirement', () => {
  const request = createSummaryRequest(
    { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'secret', model: 'deepseek-chat' },
    { sender: '刘洋', text: '麻烦今天确认一下国庆活动页最终上线时间。', images: ['/data/photo.jpg'] },
  );

  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(request.body.model, 'deepseek-chat');
  assert.match(request.body.messages[1].content, /国庆活动页/);
  assert.doesNotMatch(request.body.messages[1].content, /photo\.jpg/);
  assert.match(request.body.messages[0].content, /一句/);
});

test('formats a date for datetime-local in the local time zone', () => {
  assert.equal(toDateTimeLocal(new Date('2026-10-01T02:24:00.000Z'), 480), '2026-10-01T10:24');
});

test('keeps one monitored contact for one userid and supports removal', async () => {
  await withStore(async (store) => {
    await store.addWatchUser({ userid: 'u-100', name: '刘洋', departments: ['运营部'] });
    await store.addWatchUser({ userid: 'u-100', name: '刘洋（更新）', departments: ['市场部'] });

    assert.deepEqual(await store.listWatchUsers(), [{ userid: 'u-100', name: '刘洋（更新）', departments: ['市场部'] }]);
    await store.removeWatchUser('u-100');
    assert.deepEqual(await store.listWatchUsers(), []);
  });
});

test('uses the official CLI pagination and keeps image media ids out of text', async () => {
  const calls = [];
  const fakeExecute = async (_command, args) => {
    calls.push(args);
    if (args.includes('chat') && args.includes('groups')) {
      return { stdout: JSON.stringify({ result: { chats: [{ chat_id: 'group-1', chat_name: '产品群' }] } }) };
    }
    if (args.includes('chat') && args.includes('messages')) {
      const request = JSON.parse(args.at(-1));
      if (request.chat_id === 'group-1') {
        return { stdout: JSON.stringify({ result: { messages: [{ userid: 'member-1', user_name: '王倩', send_time: '2026-10-01 09:00:00', msg_type: 'mixed', mixed: { items: [{ msg_type: 'text', text: { content: '请补数据' } }, { msg_type: 'image', image: { media_id: 'media-image-1' } }] } }] } }) };
      }
      return { stdout: JSON.stringify({ result: { messages: [{ userid: 'u-100', user_name: '刘洋', send_time: '2026-10-01 09:01:00', msg_type: 'text', text: { content: '请确认上线时间' } }] } }) };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const source = createMessageSource({ source: 'cli', cliCommand: 'wecom-cli', workingDirectory: process.cwd() }, { execute: fakeExecute });

  const messages = await source.listHistory('2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z', [{ userid: 'u-100', name: '刘洋' }]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, '请补数据');
  assert.deepEqual(messages[0].imageMediaIds, ['media-image-1']);
  assert.doesNotMatch(messages[0].text, /media-image-1/);
  assert.ok(calls[0].includes('chat'));
  assert.ok(calls[0].includes('groups'));
  assert.equal(calls.filter((args) => args.includes('messages')).length, 2);
});

test('formats WeCom timestamps in China Standard Time', () => {
  assert.equal(toWeComTime(new Date('2026-10-01T02:24:00.000Z')), '2026-10-01 10:24:00');
});

test('reports the CLI as unavailable until its authorization status is authorized', async () => {
  const source = createMessageSource({ source: 'cli', cliCommand: 'wecom-cli', workingDirectory: process.cwd() }, {
    execute: async () => ({ stdout: 'unauthorized' }),
  });

  const status = await source.status();
  assert.equal(status.ready, false);
  assert.match(status.detail, /未授权/);
});

test('saves the selected OpenAI-compatible summary provider without exposing its key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecom-config-'));
  const envFile = path.join(directory, '.env');
  try {
    await writeFile(envFile, 'WECOM_SOURCE=cli\nDEEPSEEK_API_KEY=existing-placeholder\n', 'utf8');
    const saved = await saveSummaryConfig(envFile, {
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'new-placeholder',
    });

    assert.deepEqual(saved, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyConfigured: true });
    assert.equal((await loadConfig(envFile)).summary.model, 'deepseek-chat');
    assert.match(await readFile(envFile, 'utf8'), /DEEPSEEK_API_KEY=new-placeholder/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses port 3211 when the default dashboard port is already occupied', () => {
  assert.equal(fallbackPortFor({ code: 'EADDRINUSE' }, 3210), 3211);
  assert.equal(fallbackPortFor({ code: 'EADDRINUSE' }, 3211), null);
});

test('tests an OpenAI-compatible model connection without returning the API key', async () => {
  const calls = [];
  const result = await testSummaryConnection({
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'placeholder',
  }, async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200 };
  });

  assert.deepEqual(result, { model: 'deepseek-chat' });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].request.body).model, 'deepseek-chat');
  assert.doesNotMatch(JSON.stringify(result), /placeholder/);
});

test('shows model configuration even when the message listener has an error', () => {
  assert.equal(modelStatusHint({ summaryConfigured: true, summaryModel: 'deepseek-flash' }), '模型已配置：deepseek-flash');
  assert.equal(modelStatusHint({ summaryConfigured: false }), '未配置模型：暂以原文字显示');
});

test('uses the structured CLI error message instead of a generic command failure', () => {
  const detail = cliErrorDetail({ stdout: JSON.stringify({ error: { message: '服务发现连接被拒绝' } }), message: 'Command failed' });
  assert.equal(detail, '服务发现连接被拒绝');
});
