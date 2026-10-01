import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const demoMessages = [
  { id: 'demo-001', sender: '刘洋', receivedAt: '2026-10-01T02:24:00.000Z', text: '麻烦今天确认一下国庆活动页最终上线时间。', images: ['/demo-image.svg'], imageMediaIds: [] },
  { id: 'demo-002', sender: '王倩', receivedAt: '2026-10-01T01:17:00.000Z', text: '本周销售数据还差华东区的，请补一份。', images: [], imageMediaIds: [] },
  { id: 'demo-003', sender: '产品群', receivedAt: '2026-10-01T00:43:00.000Z', text: '报价单里的运费需要今天核对。', images: [], imageMediaIds: [] },
];

function withinRange(message, start, end) {
  const time = new Date(message.receivedAt).getTime();
  return time >= new Date(start).getTime() && time <= new Date(end).getTime();
}

export function cliErrorDetail(error) {
  try {
    const parsed = JSON.parse(String(error.stdout ?? '').trim());
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // CLI 也可能返回普通文本错误，继续使用其标准错误输出。
  }
  return error.stderr?.trim() || error.message || error.code || '未知错误';
}

function commandError(error) {
  const detail = cliErrorDetail(error);
  return new Error(`企微 CLI 调用失败：${detail}`);
}

function resultOf(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim());
    return parsed.result ?? parsed;
  } catch {
    throw new Error('企微 CLI 未返回可解析的 JSON 数据，请确认命令支持 --json。');
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isoFromWeComTime(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function contentOf(message) {
  if (message.msg_type === 'mixed') {
    const items = message.mixed?.items ?? [];
    return {
      text: items.filter((item) => item.msg_type === 'text').map((item) => item.text?.content?.trim()).filter(Boolean).join('\n'),
      imageMediaIds: items.filter((item) => item.msg_type === 'image').map((item) => item.image?.media_id).filter(Boolean),
    };
  }
  return {
    text: message.msg_type === 'text' ? (message.text?.content ?? '').trim() : '',
    imageMediaIds: message.msg_type === 'image' && message.image?.media_id ? [message.image.media_id] : [],
  };
}

function normalizeMessage(message, chat) {
  const { text, imageMediaIds } = contentOf(message);
  const messageKey = JSON.stringify({ chatId: chat.chatId, userid: message.userid, time: message.send_time, type: message.msg_type, text, imageMediaIds });
  return {
    id: `wecom-${hash(messageKey)}`,
    chatId: chat.chatId,
    sender: chat.isGroup ? `${message.user_name || '群成员'} · ${chat.name || '群聊'}` : (message.user_name || chat.name || '联系人'),
    senderUserId: message.userid ?? null,
    receivedAt: isoFromWeComTime(message.send_time),
    text: text || (imageMediaIds.length ? '收到图片' : '收到非文本消息'),
    images: [],
    imageMediaIds,
  };
}

async function pages(requestJson, service, resource, request) {
  const collected = [];
  let cursor;
  do {
    const response = await requestJson(service, resource, { ...request, ...(cursor ? { cursor } : {}) });
    collected.push(...(resource === 'groups' ? response.chats ?? [] : response.messages ?? []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return collected;
}

export function toWeComTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function createMessageSource(config, { execute = executeFile, mediaDirectory = path.join(config.workingDirectory ?? process.cwd(), 'data', 'media') } = {}) {
  const workingDirectory = config.workingDirectory ?? process.cwd();

  function cliInvocation(args) {
    if (process.platform === 'win32' && config.cliCommand === 'wecom-cli') {
      return {
        command: process.execPath,
        args: [path.join(path.dirname(process.execPath), 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js'), ...args],
      };
    }
    return { command: config.cliCommand, args };
  }

  async function runCli(args, options) {
    const invocation = cliInvocation(args);
    return execute(invocation.command, invocation.args, { cwd: workingDirectory, windowsHide: true, ...options });
  }

  async function requestJson(service, resource, request) {
    try {
      const { stdout } = await runCli([service, resource, 'list', '--json', JSON.stringify(request)], { timeout: 30_000 });
      return resultOf(stdout);
    } catch (error) {
      throw commandError(error);
    }
  }

  async function downloadImage(mediaId) {
    await mkdir(mediaDirectory, { recursive: true });
    const fileName = `${hash(mediaId)}.bin`;
    const target = path.join(mediaDirectory, fileName);
    try {
      await access(target);
      return `/media/${fileName}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const relativeTarget = path.relative(workingDirectory, target);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error('媒体文件目录必须位于项目目录内。');
    try {
      await runCli(['media', 'download', '--json', JSON.stringify({ media_id: mediaId }), '--output', relativeTarget], { timeout: 60_000 });
      await access(target);
      return `/media/${fileName}`;
    } catch (error) {
      throw commandError(error);
    }
  }

  return {
    async status() {
      if (config.source === 'demo') return { mode: 'demo', ready: true, detail: '演示数据：尚未连接企业微信' };
      try {
        const { stdout: authStatus } = await runCli(['auth', 'show', '--status'], { timeout: 10_000 });
        if (authStatus.trim() !== 'authorized') return { mode: 'cli', ready: false, detail: '企业微信 CLI 未授权，请在启动看板的同一终端执行 wecom-cli auth login。' };
        const { stdout } = await runCli(['--version'], { timeout: 10_000 });
        return { mode: 'cli', ready: true, detail: `${stdout.trim()}：群聊自动发现；私聊按联系人监听` };
      } catch (error) {
        if (error.code === 'EPERM') return { mode: 'cli', ready: false, detail: '当前启动进程无权调用企微 CLI。请关闭本服务后双击“启动需求看板.bat”。' };
        return { mode: 'cli', ready: false, detail: `无法使用 ${config.cliCommand}：${error.code || error.message}` };
      }
    },

    async searchUsers(keyword) {
      if (config.source !== 'cli') throw new Error('请先在 .env 中设置 WECOM_SOURCE=cli，然后重启服务。');
      const value = String(keyword ?? '').trim();
      if (!value) throw new Error('请输入联系人姓名或关键词。');
      try {
        const { stdout } = await runCli(['contact', 'users', 'search', '--json', JSON.stringify({ keywords: [value], search_mode: 'list' })], { timeout: 30_000 });
        const result = resultOf(stdout);
        return (result.users ?? []).map((user) => ({ userid: user.userid, name: user.name || '未命名成员', departments: user.departments ?? [] })).filter((user) => user.userid);
      } catch (error) {
        throw commandError(error);
      }
    },

    async listHistory(start, end, watchUsers = []) {
      if (config.source === 'demo') return demoMessages.filter((message) => withinRange(message, start, end));
      if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime()) || new Date(start) >= new Date(end)) throw new Error('请选择有效且递增的时间范围。');
      const begin_time = toWeComTime(new Date(start));
      const end_time = toWeComTime(new Date(end));
      const groups = await pages(requestJson, 'chat', 'groups', { begin_time, end_time });
      const chats = [
        ...groups.filter((group) => group.chat_id).map((group) => ({ chatId: group.chat_id, name: group.chat_name, isGroup: true })),
        ...watchUsers.filter((user) => user.userid).map((user) => ({ chatId: user.userid, name: user.name, isGroup: false })),
      ];
      const messages = (await Promise.all(chats.map(async (chat) => {
        const values = await pages(requestJson, 'chat', 'messages', { chat_id: chat.chatId, begin_time, end_time });
        return values.map((message) => normalizeMessage(message, chat));
      }))).flat();
      return messages.sort((left, right) => new Date(left.receivedAt) - new Date(right.receivedAt));
    },

    async materializeImages(message) {
      if (!message.imageMediaIds?.length) return message;
      return { ...message, images: await Promise.all(message.imageMediaIds.map(downloadImage)) };
    },
  };
}
