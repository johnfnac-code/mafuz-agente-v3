'use strict';
// Camada de modelo de linguagem com chamada de ferramentas.
// Funciona com OpenAI (Chat Completions) ou Anthropic (Messages) — escolha por LLM_PROVIDER.
//
// Formato interno das mensagens:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//   { role: 'tool', toolCallId, name, content }

const { log, sleep } = require('./util');

class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.paramsRemovidos = new Set();
  }

  async conversar({ sistema, mensagens, ferramentas }) {
    return this.cfg.provedor === 'anthropic'
      ? this.anthropic(sistema, mensagens, ferramentas)
      : this.openai(sistema, mensagens, ferramentas);
  }

  async post(url, headers, corpo, rotulo) {
    let ultimo;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(corpo),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        const texto = await r.text();
        if (r.ok) return JSON.parse(texto);
        ultimo = new Error(`${rotulo} HTTP ${r.status}: ${texto.slice(0, 400)}`);
        ultimo.status = r.status;
        ultimo.corpo = texto;
        if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) throw ultimo;
      } catch (e) {
        ultimo = e;
        if (e.status && e.status < 500 && e.status !== 429) throw e;
      }
      await sleep(1500 * (i + 1));
    }
    throw ultimo;
  }

  // ---------------- OpenAI ----------------
  async openai(sistema, mensagens, ferramentas) {
    const msgs = [{ role: 'system', content: sistema }];
    for (const m of mensagens) {
      if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const x = { role: 'assistant', content: m.content || null };
        if (m.toolCalls && m.toolCalls.length) {
          x.tool_calls = m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
          }));
        }
        msgs.push(x);
      } else if (m.role === 'tool') msgs.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    const corpo = {
      model: this.cfg.openaiModelo,
      messages: msgs,
      ...(ferramentas && ferramentas.length
        ? {
            tools: ferramentas.map((f) => ({
              type: 'function',
              function: { name: f.name, description: f.description, parameters: f.parameters },
            })),
          }
        : {}),
      max_completion_tokens: this.cfg.maxTokens * 3, // modelos de raciocínio contam o raciocínio aqui
    };
    if (this.cfg.openaiEsforco && !this.paramsRemovidos.has('reasoning_effort')) corpo.reasoning_effort = this.cfg.openaiEsforco;

    let d;
    try {
      d = await this.post(`${this.cfg.openaiBaseUrl}/chat/completions`, { Authorization: `Bearer ${this.cfg.openaiKey}` }, corpo, 'OpenAI');
    } catch (e) {
      // Modelo que não aceita reasoning_effort: remove e tenta de novo.
      if (e.status === 400 && /reasoning_effort/i.test(e.corpo || '') && corpo.reasoning_effort) {
        this.paramsRemovidos.add('reasoning_effort');
        delete corpo.reasoning_effort;
        log('llm_param_removido', { param: 'reasoning_effort' });
        d = await this.post(`${this.cfg.openaiBaseUrl}/chat/completions`, { Authorization: `Bearer ${this.cfg.openaiKey}` }, corpo, 'OpenAI');
      } else throw e;
    }
    const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
    const toolCalls = (msg.tool_calls || []).map((t) => {
      let args = {};
      try {
        args = JSON.parse(t.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { id: t.id, name: t.function.name, args };
    });
    return { texto: (msg.content || '').trim(), toolCalls, uso: d.usage };
  }

  // ---------------- Anthropic ----------------
  async anthropic(sistema, mensagens, ferramentas) {
    const msgs = [];
    const push = (role, bloco) => {
      const ult = msgs[msgs.length - 1];
      if (ult && ult.role === role) ult.content.push(bloco);
      else msgs.push({ role, content: [bloco] });
    };
    for (const m of mensagens) {
      if (m.role === 'user') push('user', { type: 'text', text: m.content });
      else if (m.role === 'assistant') {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const t of m.toolCalls || []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: t.args || {} });
      } else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    }
    const corpo = {
      model: this.cfg.anthropicModelo,
      max_tokens: this.cfg.maxTokens,
      temperature: 0.3,
      system: sistema,
      messages: msgs,
      ...(ferramentas && ferramentas.length ? { tools: ferramentas.map((f) => ({ name: f.name, description: f.description, input_schema: f.parameters })) } : {}),
    };
    const d = await this.post(
      `${this.cfg.anthropicBaseUrl}/v1/messages`,
      { 'x-api-key': this.cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
      corpo,
      'Anthropic'
    );
    const texto = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = (d.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { texto, toolCalls, uso: d.usage };
  }

  // Transcrição de áudio (OpenAI). Retorna null se indisponível.
  async transcrever(bufferAudio, mimeType = 'audio/ogg') {
    if (!this.cfg.openaiKey) return null;
    const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'ogg';
    const form = new FormData();
    form.append('file', new Blob([bufferAudio], { type: mimeType }), `audio.${ext}`);
    form.append('model', this.cfg.modeloTranscricao || 'whisper-1');
    form.append('language', 'pt');
    const r = await fetch(`${this.cfg.openaiBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.openaiKey}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`Transcrição HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d.text || '').trim() || null;
  }
}

module.exports = { LLM };
