'use strict';
/**
 * One platform bot for every customer. Linking is one tap: the account page makes a short-lived single-use code,
 * Telegram sends it back as "/start CODE", and that private chat then belongs to the account. Every later message of
 * the chat goes to its owner's process only; a chat that is not linked gets a hint and nothing else.
 */
const { createApi, makeRedactor } = require('../telegram/api');
const S = require('../telegram/screens');
const { plainCommands } = require('../telegram/plain');

const HELLO = '✅ تم ربط تيليجرام بحسابك في فرصة.\nستصلك هنا تنبيهات الصفقات والمخاطر.\n🧪 تداول ورقي فقط.';
const EXPIRED = 'انتهت صلاحية رابط الربط. افتح صفحة التنبيهات في فرصة واضغط «ربط تيليجرام» من جديد.';
const UNKNOWN = 'هذه المحادثة غير مرتبطة بحساب. افتح صفحة التنبيهات في فرصة واضغط «ربط تيليجرام».';

class TelegramHub {
  constructor({ token, accounts, deliver, onLink, fetchImpl, log = console.error, pollSec = 25 }) {
    Object.assign(this, { token, accounts, deliver, onLink, log, pollSec });
    this.redact = makeRedactor(() => token);
    this.api = createApi({ getToken: async () => token, fetchImpl: fetchImpl || ((...a) => globalThis.fetch(...a)), redact: this.redact });
    this.username = null;
    this.running = false;
    this.offset = 0;
    this.hinted = new Map(); // unknown chat -> last hint, so strangers cannot make the bot talk
  }

  async identify() {
    if (!this.username) { const me = await this.api.call('getMe', {}); this.username = me && /^\w{3,64}$/.test(me.username || '') ? me.username : null; }
    return this.username;
  }

  async link(userId) {
    const name = await this.identify();
    if (!name) throw Object.assign(new Error('Telegram is not available right now'), { status: 503 });
    return { url: `https://t.me/${name}?start=${await this.accounts.telegramCode(userId)}` };
  }

  say(chatId, text) { return this.api.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }).catch((e) => this.log(`[telegram] ${this.redact(e.message)}`)); }

  async handle(u) {
    const msg = u && (u.message || (u.callback_query && u.callback_query.message));
    const from = u && (u.message || u.callback_query || {}).from;
    const chat = msg && msg.chat;
    // private chats only: a group would show one customer's portfolio to its other members
    if (!chat || chat.type !== 'private' || !from || String(from.id) !== String(chat.id)) return;
    const id = String(chat.id);
    const start = u.message && /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{20,64})$/.exec(u.message.text || '');
    if (start) {
      const r = await this.accounts.telegramLink(start[1], id);
      if (!r) { await this.say(id, EXPIRED); return; }
      for (const x of r.released) this.onLink(x, null);
      this.onLink(r.userId, id);
      await this.say(id, HELLO);
      return;
    }
    const owner = await this.accounts.telegramOwner(id);
    if (owner) { await this.deliver(owner, u); return; }
    const t = Date.now();
    if (t - (this.hinted.get(id) || 0) > 600000) { if (this.hinted.size > 5000) this.hinted.clear(); this.hinted.set(id, t); await this.say(id, UNKNOWN); }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = this.poll();
  }

  async poll() {
    const commands = plainCommands(S.COMMANDS).map(([command, d]) => ({ command, description: d.slice(0, 256) }));
    this.api.call('setMyCommands', { commands }).catch(() => {});
    let wait = 0;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const list = await this.api.call('getUpdates', { offset: this.offset, timeout: this.pollSec, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (this.pollSec + 15) * 1000, signal: this.abort.signal });
        wait = Array.isArray(list) && list.length ? 0 : 250;
        for (const u of Array.isArray(list) ? list : []) {
          this.offset = Math.max(this.offset, u.update_id + 1); // before handling: a bad message can never loop
          try { await this.handle(u); } catch (e) { this.log(`[telegram] ${this.redact(e.message)}`); }
        }
      } catch (e) {
        if (!this.running) break;
        this.log(`[telegram] ${this.redact(e.message)}`);
        wait = e.status === 409 ? 30000 : [401, 404].includes(e.status) ? 300000 : Math.min(60000, Math.max(2000, wait * 2));
      }
      if (this.running && wait) await new Promise((r) => { this.wake = r; setTimeout(r, wait).unref(); });
    }
  }

  async stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    if (this.wake) this.wake();
    await this.loop;
  }
}

module.exports = { TelegramHub };
