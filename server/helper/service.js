'use strict';
/**
 * The chat helper of one account. With a connected model it asks the Mastra agent in a separate process; without one,
 * over the daily limit, or when the model fails, it answers from fixed rules. It can read, never act.
 */
const { answer } = require('./answers');

const DAY = 86400000;
const KEEP = 40;
const AGENT_PER_DAY = 60;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

class HelperService {
  constructor({ store, lab, getBundle, activity, now = Date.now }) {
    Object.assign(this, { store, lab, getBundle, activity, now });
    this.busy = false; this.used = [];
    let m = []; try { m = store.getSetting('helper.chat', []) || []; } catch { m = []; }
    this.messages = m;
  }

  save() { try { this.store.setSetting('helper.chat', this.messages); } catch { /* the chat still works */ } }
  clear() { this.messages = []; this.save(); return this.status(); }
  model() { this.used = this.used.filter((t) => this.now() - t < DAY); return this.used.length < AGENT_PER_DAY && this.lab ? this.lab.getModel() : null; }
  status() { return { messages: this.messages, smart: !!(this.lab && this.lab.getModel()) }; }

  async ask(input) {
    const text = String((input && input.text) || '').trim(); const lang = input && input.lang === 'en' ? 'en' : 'ar';
    if (!text) throw bad('Write your question');
    if (text.length > 1000) throw bad('That question is too long');
    if (this.busy) throw bad('An answer is already being prepared', 409);
    this.busy = true;
    try {
      const bundle = await this.getBundle(text); const rules = answer(text, bundle, lang); const model = bundle.session ? this.model() : null;
      let out = { text: rules.text, links: rules.links, symbols: rules.symbols || [], growth: rules.growth || null, by: 'rules' };
      if (model) {
        this.used.push(this.now());
        try { const r = await this.lab.work({ task: 'chat', ask: { text, history: this.messages, bundle }, model, lang }, { steps: {} }); if (r.text) out = { text: r.text, links: rules.links, symbols: r.symbols, sources: r.sources || [], growth: rules.growth || null, by: 'agent' }; } catch (e) { if (this.activity) this.activity.warn(`The helper answered from rules: ${e.message}`, { source: 'helper' }); }
      }
      this.messages.push({ role: 'user', text, at: this.now() }, { role: 'helper', ...out, at: this.now() });
      this.messages = this.messages.slice(-KEEP);
      this.save();
      return this.status();
    } finally { this.busy = false; }
  }
}

module.exports = { HelperService };
