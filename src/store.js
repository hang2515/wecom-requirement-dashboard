import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY_STATE = { requirements: [], importedMessageIds: [], watchUsers: [], listener: { running: false, lastSyncAt: null, error: null } };

function cloneEmptyState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

export function createStore(dataFile) {
  async function readState() {
    try {
      return { ...cloneEmptyState(), ...JSON.parse(await readFile(dataFile, 'utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') return cloneEmptyState();
      throw error;
    }
  }

  async function saveState(state) {
    await mkdir(path.dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporaryFile, dataFile);
  }

  async function addRequirement(state, message, source) {
    const requirement = {
      id: randomUUID(),
      source,
      messageId: message.id ?? null,
      sender: message.sender ?? '我',
      receivedAt: message.receivedAt ?? new Date().toISOString(),
      title: message.summary ?? message.title,
      note: message.text ?? message.note ?? '',
      images: message.images ?? [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    state.requirements.unshift(requirement);
    if (message.id) state.importedMessageIds.push(message.id);
    return requirement;
  }

  return {
    async addManualRequirement({ title, note = '' }) {
      if (!title?.trim()) throw new Error('需求内容不能为空');
      const state = await readState();
      const requirement = await addRequirement(state, { title: title.trim(), note: note.trim() }, 'manual');
      await saveState(state);
      return requirement;
    },

    async importSelectedMessages(messages) {
      const state = await readState();
      const imported = [];
      for (const message of messages) {
        if (!message.id || state.importedMessageIds.includes(message.id)) continue;
        imported.push(await addRequirement(state, message, 'wecom'));
      }
      await saveState(state);
      return imported;
    },

    async previewHistory(messages) {
      const state = await readState();
      return messages.filter((message) => message.id && !state.importedMessageIds.includes(message.id));
    },

    async completeRequirement(id) {
      const state = await readState();
      const requirement = state.requirements.find((item) => item.id === id);
      if (!requirement) throw new Error('未找到该需求');
      requirement.status = 'completed';
      requirement.completedAt = new Date().toISOString();
      await saveState(state);
      return requirement;
    },

    async listRequirements(status = 'pending') {
      const state = await readState();
      return state.requirements.filter((item) => item.status === status);
    },

    async addWatchUser(user) {
      if (!user?.userid || !user?.name) throw new Error('请选择有效的企业微信成员。');
      const state = await readState();
      const next = { userid: user.userid, name: user.name, departments: user.departments ?? [] };
      const index = state.watchUsers.findIndex((item) => item.userid === next.userid);
      if (index === -1) state.watchUsers.push(next);
      else state.watchUsers[index] = next;
      await saveState(state);
      return next;
    },

    async removeWatchUser(userid) {
      const state = await readState();
      state.watchUsers = state.watchUsers.filter((user) => user.userid !== userid);
      await saveState(state);
    },

    async listWatchUsers() {
      const state = await readState();
      return state.watchUsers;
    },

    async getState() {
      return readState();
    },

    async setListener(listener) {
      const state = await readState();
      state.listener = { ...state.listener, ...listener };
      await saveState(state);
      return state.listener;
    },
  };
}
