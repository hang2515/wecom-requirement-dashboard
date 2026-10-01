export async function testSummaryConnection({ baseUrl, model, apiKey }, fetcher = fetch) {
  const url = `${String(baseUrl ?? '').trim().replace(/\/$/, '')}/chat/completions`;
  if (!/^https?:\/\//.test(url)) throw new Error('接口地址必须以 http:// 或 https:// 开头。');
  if (!String(model ?? '').trim()) throw new Error('请填写模型名称。');
  if (!apiKey) throw new Error('请先填写 API Key，或先保存已有密钥。');
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    });
  } catch {
    throw new Error('无法连接模型接口，请检查地址和网络。');
  }
  if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}。请检查 API Key、模型名称和权限。`);
  return { model: String(model).trim() };
}
