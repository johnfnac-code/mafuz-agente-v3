'use strict';
// Google Agenda dos corretores: horários livres de verdade e o evento da visita.
//
// Usa uma conta de serviço do Google Cloud (sem dependências: o token é assinado
// com o crypto do Node). Cada corretor compartilha a própria agenda com o e-mail
// da conta de serviço, com a permissão "Fazer alterações nos eventos". A Gabi lê
// só ocupado/livre (freeBusy) e cria o evento da visita na agenda de quem vai atender.

const crypto = require('crypto');
const { log, partesSP, proximosDiasVisita } = require('./util');

const FUSO = 'America/Sao_Paulo';
const OFFSET = '-03:00'; // Brasília sem horário de verão

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function lerContaServico(texto) {
  if (!texto) return null;
  try {
    const bruto = texto.trim().startsWith('{') ? texto : Buffer.from(texto, 'base64').toString('utf8');
    const j = JSON.parse(bruto);
    return j.client_email && j.private_key ? j : null;
  } catch {
    return null;
  }
}

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

class Agenda {
  constructor(config, { fetchImpl } = {}) {
    this.cfg = config.agenda;
    this.regras = config.comportamento.horarioVisitas;
    this.equipe = config.equipe;
    this.conta = lerContaServico(this.cfg.contaServico);
    this.token = null;
    this.fetch = fetchImpl || fetch;
  }

  ativa() {
    return !!this.conta && this.cfg.corretores.length > 0;
  }

  status() {
    return {
      ativa: this.ativa(),
      conta_servico: this.conta ? this.conta.client_email : null,
      corretores: this.cfg.corretores.map((c) => c.email),
    };
  }

  async acesso() {
    if (this.token && this.token.expira > Date.now() + 60000) return this.token.valor;
    const agora = Math.floor(Date.now() / 1000);
    const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const corpo = b64url(
      JSON.stringify({
        iss: this.conta.client_email,
        scope: 'https://www.googleapis.com/auth/calendar',
        aud: 'https://oauth2.googleapis.com/token',
        iat: agora,
        exp: agora + 3600,
      })
    );
    const assinatura = b64url(crypto.createSign('RSA-SHA256').update(`${cab}.${corpo}`).sign(this.conta.private_key));
    const r = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${cab}.${corpo}.${assinatura}`,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google recusou o acesso: ${j.error_description || j.error || r.status}`);
    this.token = { valor: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
    return this.token.valor;
  }

  /** Corretores com agenda conectada, da carteira (venda/locação), ou todos. */
  corretoresDa(carteira) {
    const fones = carteira === 'locacao' ? this.equipe.locacao : carteira === 'venda' ? this.equipe.venda : [];
    const lista = this.cfg.corretores.filter((c) => !fones.length || fones.includes(c.fone));
    return lista.length ? lista : this.cfg.corretores;
  }

  async ocupados(emails, inicioISO, fimISO) {
    const token = await this.acesso();
    const r = await this.fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: inicioISO, timeMax: fimISO, timeZone: FUSO, items: emails.map((id) => ({ id })) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`freeBusy ${r.status}`);
    const out = {};
    for (const email of emails) {
      const c = (j.calendars || {})[email] || {};
      if (c.errors && c.errors.length) {
        log('agenda_sem_acesso', { email, erro: c.errors[0].reason });
        continue; // agenda não compartilhada: não entra na oferta
      }
      out[email] = (c.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
    }
    return out;
  }

  /**
   * Até `limite` horários livres nos próximos dias, dentro da janela de visitas.
   * Prefere a data e o período pedidos pelo cliente, quando houver.
   */
  async horariosLivres({ carteira, data, periodo, limite = 3 } = {}, agora = new Date()) {
    const corretores = this.corretoresDa(carteira);
    const dias = proximosDiasVisita(this.regras, this.cfg.diasAFrente, agora);
    if (!dias.length || !corretores.length) return [];
    const inicio = `${dias[0].data}T00:00:00${OFFSET}`;
    const fim = `${dias[dias.length - 1].data}T23:59:59${OFFSET}`;
    const ocup = await this.ocupados(corretores.map((c) => c.email), inicio, fim);
    const dur = this.cfg.duracaoMin;
    const slots = [];
    for (const d of dias) {
      for (let m = Math.ceil(d.abre / 60) * 60; m + dur <= d.fecha; m += 60) {
        const ini = Date.parse(`${d.data}T${hm(m)}:00${OFFSET}`);
        const fimSlot = ini + dur * 60000;
        const livres = corretores.filter((c) => ocup[c.email] && !ocup[c.email].some(([a, b]) => a < fimSlot + 30 * 60000 && b > ini - 30 * 60000));
        if (!livres.length) continue;
        const periodoSlot = m < 12 * 60 ? 'manha' : m < 18 * 60 ? 'tarde' : 'noite';
        const dt = new Date(`${d.data}T12:00:00Z`);
        slots.push({
          id: `${d.data}T${hm(m)}`,
          data: d.data,
          hora: hm(m),
          rotulo: `${DIAS[dt.getUTCDay()]}, ${d.data.slice(8, 10)}/${d.data.slice(5, 7)} às ${m / 60}h`,
          periodo: periodoSlot,
          corretores: livres.map((c) => c.fone),
          pontos: (data && d.data === data ? 10 : 0) + (periodo && periodo !== 'qualquer' && periodoSlot === periodo ? 5 : 0),
        });
      }
    }
    // Mais aderentes primeiro; em seguida, os mais próximos; no máximo um por período de cada dia.
    const vistos = new Set();
    return slots
      .sort((a, b) => b.pontos - a.pontos || a.id.localeCompare(b.id))
      .filter((s) => {
        const k = `${s.data}|${s.periodo}`;
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      })
      .slice(0, limite)
      .map(({ pontos, ...s }) => s);
  }

  /** Confere se o horário segue livre e escolhe o corretor (o primeiro livre da carteira). */
  async reservar({ carteira, data, hora, titulo, descricao }) {
    const corretores = this.corretoresDa(carteira);
    const ini = Date.parse(`${data}T${hora}:00${OFFSET}`);
    const fim = ini + this.cfg.duracaoMin * 60000;
    const ocup = await this.ocupados(corretores.map((c) => c.email), new Date(ini - 3600000).toISOString(), new Date(fim + 3600000).toISOString());
    const livre = corretores.find((c) => ocup[c.email] && !ocup[c.email].some(([a, b]) => a < fim && b > ini));
    if (!livre) return { ok: false, motivo: 'ocupado' };
    if (!this.cfg.criarEvento) return { ok: true, corretor: livre, evento: null };
    const token = await this.acesso();
    const r = await this.fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(livre.email)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: titulo,
        description: descricao,
        start: { dateTime: `${data}T${hora}:00${OFFSET}`, timeZone: FUSO },
        end: { dateTime: new Date(fim).toISOString(), timeZone: FUSO },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      log('agenda_evento_erro', { status: r.status, erro: (j.error && j.error.message) || '' });
      return { ok: true, corretor: livre, evento: null };
    }
    return { ok: true, corretor: livre, evento: j.htmlLink || j.id };
  }
}

module.exports = { Agenda, lerContaServico };
