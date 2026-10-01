import { toDateTimeLocal } from './time.js';
import { modelStatusHint } from './status.js';

const elements = {
  connection: document.querySelector('#connection'), pendingCount: document.querySelector('#pending-count'),
  completedCount: document.querySelector('#completed-count'), requirementList: document.querySelector('#requirement-list'),
  completedList: document.querySelector('#completed-list'), showCompleted: document.querySelector('#show-completed'),
  summaryHint: document.querySelector('#summary-hint'), historyForm: document.querySelector('#history-form'),
  candidateSection: document.querySelector('#candidate-section'), candidateList: document.querySelector('#candidate-list'),
  candidateCount: document.querySelector('#candidate-count'), selectAll: document.querySelector('#select-all'),
  importCandidates: document.querySelector('#import-candidates'), historyMessage: document.querySelector('#history-message'),
  addDialog: document.querySelector('#add-dialog'), addForm: document.querySelector('#add-form'),
  watchSearchForm: document.querySelector('#watch-search-form'), watchResults: document.querySelector('#watch-search-results'),
  watchUsers: document.querySelector('#watch-users'), watchMessage: document.querySelector('#watch-message'),
  settingsDialog: document.querySelector('#settings-dialog'), settingsForm: document.querySelector('#settings-form'),
  settingsMessage: document.querySelector('#settings-message'), showSettings: document.querySelector('#show-settings'), testModel: document.querySelector('#test-model'),
};
let candidates = [];
let searchedUsers = [];

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[character]); }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(value)); }
function avatar(sender) { return escapeHtml((sender || '?').slice(0, 1)); }
async function api(url, options = {}) { const response = await fetch(url, { headers: { 'Content-Type':'application/json' }, ...options }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data; }

function renderRows(items, container, isCompleted = false) {
  if (!items.length) { container.innerHTML = `<div class="empty">${isCompleted ? '暂无已完成需求' : '目前没有待处理需求'}</div>`; return; }
  container.innerHTML = items.map((item) => `<article class="requirement-row">
    <div class="sender ${item.sender.includes('群') ? 'group' : ''}"><span class="avatar">${avatar(item.sender)}</span><span>${escapeHtml(item.sender)}</span></div>
    <div class="requirement-content"><div class="requirement-title">${escapeHtml(item.title)}</div>${item.note && item.note !== item.title ? `<div class="requirement-note">${escapeHtml(item.note)}</div>` : ''}</div>
    ${item.images?.length ? `<div class="image-thumbs">${item.images.map((image, index) => `<div class="image-thumb"><img src="${encodeURI(image)}" alt="${escapeHtml(item.sender)}发送的图片 ${index + 1}"></div>`).join('')}</div>` : '<span class="no-image">—</span>'}
    <time class="time">${formatTime(item.receivedAt)}</time>
    ${isCompleted ? '<span class="time">已完成</span>' : `<button class="secondary complete-action" data-complete="${item.id}">标记完成</button>`}
  </article>`).join('');
}

function renderWatchUsers(users) {
  elements.watchUsers.innerHTML = users.length ? `<div class="watch-label">正在监听</div>${users.map((user) => `<div class="watch-user"><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.departments.join(' / ') || '未设置部门')}</small></span><button class="remove-watch" data-remove-watch="${encodeURIComponent(user.userid)}" aria-label="移除 ${escapeHtml(user.name)}">移除</button></div>`).join('')}` : '<div class="watch-empty">尚未添加私聊联系人</div>';
}

function renderSearchResults() {
  elements.watchResults.innerHTML = searchedUsers.map((user, index) => `<div class="watch-user"><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.departments.join(' / ') || '未设置部门')}</small></span><button class="secondary add-watch" data-watch-result="${index}">添加</button></div>`).join('');
}

async function refreshBoard() {
  const board = await api('/api/board');
  elements.connection.textContent = board.listener.error ? `${board.listener.detail} · ${board.listener.error}` : board.listener.detail;
  elements.connection.className = `connection ${board.listener.ready ? 'ready' : ''} ${board.listener.mode === 'demo' ? 'demo' : ''}`;
  elements.pendingCount.textContent = `(${board.pending.length})`;
  elements.completedCount.textContent = `(${board.completed.length})`;
  elements.summaryHint.textContent = modelStatusHint(board);
  renderRows(board.pending, elements.requirementList);
  renderRows(board.completed, elements.completedList, true);
  renderWatchUsers(board.watchUsers);
}

function renderCandidates() {
  elements.candidateCount.textContent = `(${candidates.length})`;
  elements.candidateList.innerHTML = candidates.length ? candidates.map((item, index) => `<label class="candidate"><input type="checkbox" data-candidate="${index}"><span class="candidate-body"><span class="candidate-sender">${escapeHtml(item.sender)}</span><span class="candidate-text">${escapeHtml(item.text)}</span><span class="candidate-time">${formatTime(item.receivedAt)}</span></span></label>`).join('') : '<div class="empty">这个时段没有可补录的新需求</div>';
  elements.importCandidates.disabled = !candidates.length;
}

elements.requirementList.addEventListener('click', async (event) => {
  const id = event.target.dataset.complete; if (!id) return;
  await api(`/api/requirements/${id}/complete`, { method:'POST' }); await refreshBoard();
});
document.querySelector('#show-add').addEventListener('click', () => elements.addDialog.showModal());
elements.addForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(elements.addForm);
  await api('/api/requirements/manual', { method:'POST', body:JSON.stringify({ title:form.get('title'), note:form.get('note') }) });
  elements.addForm.reset(); elements.addDialog.close(); await refreshBoard();
});
elements.showCompleted.addEventListener('click', () => elements.completedList.classList.toggle('hidden'));
elements.showSettings.addEventListener('click', async () => {
  elements.settingsMessage.className = 'form-message'; elements.settingsMessage.textContent = '正在读取本机配置…';
  try {
    const settings = await api('/api/settings/summary');
    elements.settingsForm.elements.baseUrl.value = settings.baseUrl;
    elements.settingsForm.elements.model.value = settings.model;
    elements.settingsForm.elements.apiKey.value = '';
    elements.settingsMessage.textContent = settings.apiKeyConfigured ? '已配置密钥；留空可保持不变。' : '尚未配置密钥。';
    elements.settingsDialog.showModal();
  } catch (error) { elements.settingsMessage.className = 'form-message error'; elements.settingsMessage.textContent = error.message; elements.settingsDialog.showModal(); }
});
elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(elements.settingsForm);
  elements.settingsMessage.className = 'form-message'; elements.settingsMessage.textContent = '正在保存到本机配置…';
  try {
    await api('/api/settings/summary', { method: 'POST', body: JSON.stringify({ baseUrl: form.get('baseUrl'), model: form.get('model'), apiKey: form.get('apiKey') }) });
    elements.settingsDialog.close(); await refreshBoard();
  } catch (error) { elements.settingsMessage.className = 'form-message error'; elements.settingsMessage.textContent = error.message; }
});
elements.testModel.addEventListener('click', async () => {
  const form = new FormData(elements.settingsForm);
  elements.settingsMessage.className = 'form-message'; elements.settingsMessage.textContent = '正在测试模型连接…';
  try {
    const result = await api('/api/settings/summary/test', { method: 'POST', body: JSON.stringify({ baseUrl: form.get('baseUrl'), model: form.get('model'), apiKey: form.get('apiKey') }) });
    elements.settingsMessage.className = 'form-message success'; elements.settingsMessage.textContent = `连接成功：${result.model}`;
  } catch (error) { elements.settingsMessage.className = 'form-message error'; elements.settingsMessage.textContent = error.message; }
});
elements.watchSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const keyword = new FormData(elements.watchSearchForm).get('keyword');
  elements.watchMessage.className = 'form-message'; elements.watchMessage.textContent = '正在搜索企业微信成员…';
  try {
    const result = await api(`/api/watch-users/search?keyword=${encodeURIComponent(keyword)}`);
    searchedUsers = result.users; renderSearchResults();
    elements.watchMessage.textContent = searchedUsers.length ? '选择成员后会开始监听其私聊。' : '没有匹配的成员。';
  } catch (error) { elements.watchMessage.className = 'form-message error'; elements.watchMessage.textContent = error.message; }
});
elements.watchResults.addEventListener('click', async (event) => {
  const index = event.target.dataset.watchResult; if (index === undefined) return;
  try {
    await api('/api/watch-users', { method: 'POST', body: JSON.stringify(searchedUsers[Number(index)]) });
    searchedUsers = []; renderSearchResults(); elements.watchMessage.className = 'form-message success'; elements.watchMessage.textContent = '已加入监听。'; await refreshBoard();
  } catch (error) { elements.watchMessage.className = 'form-message error'; elements.watchMessage.textContent = error.message; }
});
elements.watchUsers.addEventListener('click', async (event) => {
  const userid = event.target.dataset.removeWatch; if (!userid) return;
  await api(`/api/watch-users/${userid}`, { method: 'DELETE' }); await refreshBoard();
});
elements.historyForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(elements.historyForm);
  elements.historyMessage.className = 'form-message'; elements.historyMessage.textContent = '正在读取候选消息…';
  try { const result = await api('/api/history/preview', { method:'POST', body:JSON.stringify({ start:new Date(form.get('start')).toISOString(), end:new Date(form.get('end')).toISOString() }) }); candidates = result.candidates; elements.candidateSection.classList.remove('hidden'); renderCandidates(); elements.historyMessage.textContent = '请勾选要加入待处理列表的需求。'; }
  catch (error) { elements.historyMessage.className = 'form-message error'; elements.historyMessage.textContent = error.message; }
});
elements.selectAll.addEventListener('change', () => document.querySelectorAll('[data-candidate]').forEach((item) => { item.checked = elements.selectAll.checked; }));
elements.importCandidates.addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('[data-candidate]:checked')].map((element) => candidates[Number(element.dataset.candidate)]);
  if (!selected.length) { elements.historyMessage.className = 'form-message error'; elements.historyMessage.textContent = '请至少选择一条候选需求。'; return; }
  try { await api('/api/history/import', { method:'POST', body:JSON.stringify({ messages:selected }) }); elements.historyMessage.className = 'form-message success'; elements.historyMessage.textContent = `已导入 ${selected.length} 条需求。`; candidates = []; renderCandidates(); await refreshBoard(); }
  catch (error) { elements.historyMessage.className = 'form-message error'; elements.historyMessage.textContent = error.message; }
});

const now = new Date(); const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
document.querySelector('#history-start').value = toDateTimeLocal(start); document.querySelector('#history-end').value = toDateTimeLocal(now);
refreshBoard().catch((error) => { elements.connection.textContent = error.message; });
