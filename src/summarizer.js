export function createSummaryRequest(config, message) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  return {
    url: `${baseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    },
    body: {
      model: config.model,
      temperature: 0.2,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: '你是工作需求整理助手。把文字内容压缩为一句简短、具体、可执行的中文需求。不要解释，不要补充图片内容，不超过30个汉字。',
        },
        { role: 'user', content: `发送人：${message.sender}\n文字消息：${message.text}` },
      ],
    },
  };
}

export async function summarizeMessage(config, message, fetcher = fetch) {
  if (!config.apiKey) return message.text?.trim() || '收到一条图片消息';
  const request = createSummaryRequest(config, message);
  const response = await fetcher(request.url, { ...request.options, body: JSON.stringify(request.body) });
  if (!response.ok) throw new Error(`摘要服务请求失败：${response.status}`);
  const data = await response.json();
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error('摘要服务没有返回内容');
  return summary.replace(/\s+/g, ' ').slice(0, 60);
}
