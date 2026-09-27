'use strict';
// Estado do agente: conversas, leads, visitas e trilha de eventos.
// Fica em memória e é gravado em disco a cada 10s (DATA_DIR/estado.json).
// Na Railway, monte um Volume em /app/data para o estado sobreviver a redeploys.

const fs = require('fs');
const path = require('path');
const { log } = require('./util');

const MAX_HISTORICO = 40;
const MAX_EVENTOS = 2000;

class Store {
  constructor(dir, { conversaTtlDias = 15 } = {}) {
    this.dir = dir;
    this.arquivo = path.join(dir, 'estado.json');
    this.ttlMs = conversaTtlDias * 86400000;
    this.conversas = {};
    this.leads = {};
    this.visitas = [];
    this.eventos = [];
    this.processados = {};
    this.global = { botAtivo: null };
    this.sujo = false;
    this.carregar();
    this.timer = setInterval(() => this.salvar(), 10000);
    this.timer.unref();
  }

  carregar() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.arquivo)) return;
      const d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
      Object.assign(this, {
        conversas: d.conversas || {},
        leads: d.leads || {},
        visitas: d.visitas || [],
        eventos: d.eventos || [],
        processados: d.processados || {},
        global: d.global || { botAtivo: null },
      });
      log('estado_carregado', { conversas: Object.keys(this.conversas).length, leads: Object.keys(this.leads).length });
    } catch (e) {
      log('estado_erro_carregar', { erro: e.message });
    }
  }

  salvar(forcar = false) {
    if (!this.sujo && !forcar) return;
    try {
      // limpa ids de mensagens processadas há mais de 2 dias
      const limite = Date.now() - 2 * 86400000;
      for (const [id, ts] of Object.entries(this.processados)) if (ts < limite) delete this.processados[id];
      const tmp = this.arquivo + '.tmp';
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          conversas: this.conversas,
          leads: this.leads,
          visitas: this.visitas,
          eventos: this.eventos,
          processados: this.processados,
          global: this.global,
        })
      );
      fs.renameSync(tmp, this.arquivo);
      this.sujo = false;
    } catch (e) {
      log('estado_erro_salvar', { erro: e.message });
    }
  }

  tocar() {
    this.sujo = true;
  }

  jaProcessado(messageId) {
    if (!messageId) return false;
    if (this.processados[messageId]) return true;
    this.processados[messageId] = Date.now();
    this.sujo = true;
    return false;
  }

  conversa(fone) {
    let c = this.conversas[fone];
    const agora = Date.now();
    if (c && agora - (c.atualizadaEm || 0) > this.ttlMs) {
      // conversa antiga: começa do zero, mantém só o nome
      c = { ...this.novaConversa(fone), nome: c.nome || '' };
      this.conversas[fone] = c;
    }
    if (!c) {
      c = this.novaConversa(fone);
      this.conversas[fone] = c;
    }
    this.sujo = true;
    return c;
  }

  novaConversa(fone) {
    return {
      fone,
      nome: '',
      criadaEm: Date.now(),
      atualizadaEm: Date.now(),
      historico: [],
      turnosCliente: 0,
      turnosSemAvanco: 0,
      qualificacao: {},
      imoveis: {},
      urlsPermitidas: [],
      origem: null,
      pausadoAte: 0,
      motivoPausa: '',
      transferencias: [],
      visitas: [],
      leadEnviadoImoview: false,
      temperatura: null,
      lgpdAvisado: false,
      falhas: 0,
      // reengajamento
      optOut: false,
      humanoAssumiuEm: 0,
      reeng: { cutucadaDe: 0, followups: {} },
    };
  }

  adicionarHistorico(conv, papel, texto, extra = {}) {
    conv.historico.push({ papel, texto: String(texto).slice(0, 4000), ts: Date.now(), ...extra });
    if (conv.historico.length > MAX_HISTORICO) conv.historico.splice(0, conv.historico.length - MAX_HISTORICO);
    conv.atualizadaEm = Date.now();
    this.sujo = true;
  }

  evento(tipo, dados = {}) {
    this.eventos.push({ ts: new Date().toISOString(), tipo, ...dados });
    if (this.eventos.length > MAX_EVENTOS) this.eventos.splice(0, this.eventos.length - MAX_EVENTOS);
    this.sujo = true;
  }

  pausado(fone) {
    const c = this.conversas[fone];
    return !!c && c.pausadoAte > Date.now();
  }

  pausar(fone, horas, motivo) {
    this.pausarMin(fone, horas * 60, motivo);
  }

  pausarMin(fone, minutos, motivo) {
    const c = this.conversa(fone);
    c.pausadoAte = Date.now() + minutos * 60000;
    c.motivoPausa = motivo;
    this.sujo = true;
  }

  retomar(fone) {
    const c = this.conversas[fone];
    if (!c) return false;
    c.pausadoAte = 0;
    c.motivoPausa = '';
    c.turnosSemAvanco = 0;
    this.sujo = true;
    return true;
  }
}

module.exports = { Store };
