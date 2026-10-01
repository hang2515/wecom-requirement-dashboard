import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function readEnvFile(file) {
  try {
    const content = await readFile(file, 'utf8');
    return Object.fromEntries(content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
      const divider = line.indexOf('=');
      return [line.slice(0, divider).trim(), line.slice(divider + 1).trim().replace(/^['"]|['"]$/g, '')];
    }).filter(([key]) => key));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function loadConfig(envFile) {
  const fileValues = await readEnvFile(envFile);
  const value = (name, fallback = '') => process.env[name] || fileValues[name] || fallback;
  return {
    port: Number(value('PORT', '3210')),
    source: value('WECOM_SOURCE', 'demo'),
    cliCommand: value('WECOM_CLI_COMMAND', 'wecom-cli'),
    selfMessageUserId: value('WECOM_SELF_MESSAGE_USERID'),
    pollIntervalMs: Math.max(30_000, Number(value('WECOM_POLL_INTERVAL_MS', '120000'))),
    summary: {
      baseUrl: value('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
      apiKey: value('DEEPSEEK_API_KEY'),
      model: value('DEEPSEEK_MODEL', 'deepseek-chat'),
    },
  };
}

function replaceEnvValue(content, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^\\s*${name}=`);
  const lines = content ? content.split(/\r?\n/) : [];
  let replaced = false;
  const updated = lines.map((current) => {
    if (!pattern.test(current)) return current;
    replaced = true;
    return line;
  });
  if (!replaced) updated.push(line);
  return `${updated.filter((current, index) => current || index < updated.length - 1).join('\n')}\n`;
}

export async function saveSummaryConfig(envFile, { baseUrl, model, apiKey }) {
  const normalizedBaseUrl = String(baseUrl ?? '').trim().replace(/\/$/, '');
  const normalizedModel = String(model ?? '').trim();
  if (!/^https?:\/\//.test(normalizedBaseUrl)) throw new Error('接口地址必须以 http:// 或 https:// 开头。');
  if (!normalizedModel) throw new Error('请填写模型名称。');
  if (/[\r\n]/.test(String(apiKey ?? ''))) throw new Error('API Key 不能包含换行符。');

  let content = '';
  try {
    content = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  content = replaceEnvValue(content, 'DEEPSEEK_BASE_URL', normalizedBaseUrl);
  content = replaceEnvValue(content, 'DEEPSEEK_MODEL', normalizedModel);
  if (apiKey) content = replaceEnvValue(content, 'DEEPSEEK_API_KEY', String(apiKey));
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, content, 'utf8');
  return { baseUrl: normalizedBaseUrl, model: normalizedModel, apiKeyConfigured: Boolean(apiKey || (await loadConfig(envFile)).summary.apiKey) };
}
