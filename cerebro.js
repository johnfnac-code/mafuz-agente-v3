'use strict';
// 2º Cérebro da MAFUZ: memória da equipe + perguntas do painel respondidas pela IA
// com os números do site (enviados pelo painel), as conversas do WhatsApp e as
// anotações que a equipe guarda. Arquivo próprio em DATA_DIR/cerebro.json.

const fs = require('fs');
const path = require('path');
const { log, textoAgora } = require('./util');

const MAX_MEMORIAS = 400;
const MAX_PERGUNTAS = 300;

class Cerebro {
  constructor(dir) {
    this.arquivo = path.join(dir, 'cerebro.json');
    this.memorias = [];
    this.perguntas = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.arquivo)) {
        const d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
        this.memorias = d.memorias || [];
        this.perguntas = d.perguntas || [];
      }
    } catch (e) {
      log('cerebro_erro_carregar', { erro: e.message });
    }
  }

  salvar() {
    try {
      const tmp = this.arquivo + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ memorias: this.memorias, perguntas: this.perguntas }));
      fs.renameSync(tmp, this.arquivo);
    } catch (e) {
      log('cerebro_erro_salvar', { erro: e.message });
    }
  }

  lembrar(texto, autor) {
    const m = { id: 'M' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), texto: String(texto).trim().slice(0, 1500), autor: autor || '', criadaEm: Date.now() };
    this.memorias.unshift(m);
    if (this.memorias.length > MAX_MEMORIAS) this.memorias.length = MAX_MEMORIAS;
    this.salvar();
    return m;
  }

  esquecer(id) {
    const antes = this.memorias.length;
    this.memorias = this.memorias.filter((m) => m.id !== id);
    if (this.memorias.length !== antes) this.salvar();
    return antes !== this.memorias.length;
  }

  registrarPergunta(pergunta, resposta, autor) {
    this.perguntas.unshift({ pergunta: String(pergunta).slice(0, 400), resposta: String(resposta).slice(0, 800), autor: autor || '', ts: Date.now() });
    if (this.perguntas.length > MAX_PERGUNTAS) this.perguntas.length = MAX_PERGUNTAS;
    this.salvar();
  }

  /** Memórias mais relevantes para a pergunta (palavras em comum), mais as recentes. */
  relevantes(pergunta, limite = 40) {
    const sem = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const termos = new Set(sem(pergunta).split(/[^a-z0-9]+/).filter((t) => t.length > 3));
    const pontua = (m) => sem(m.texto).split(/[^a-z0-9]+/).filter((t) => termos.has(t)).length;
    const porRelevancia = [...this.memorias].map((m) => ({ m, p: pontua(m) })).filter((x) => x.p > 0).sort((a, b) => b.p - a.p).map((x) => x.m);
    const escolhidas = [...porRelevancia.slice(0, limite / 2), ...this.memorias].filter((m, i, arr) => arr.indexOf(m) === i);
    return escolhidas.slice(0, limite);
  }
}

function montarSistema({ fatos, rascunho, servidor, memorias, perguntasRecentes, usuario, agora = new Date() }) {
  const data = (ts) => new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  return [
    'Você é o 2º Cérebro da MAFUZ Imóveis de Luxo (Nova Lima e Belo Horizonte): a memória operacional da empresa.',
    `Quem pergunta: ${usuario.nome} (${(usuario.papeis || []).join(', ')}). Agora: ${textoAgora(agora)}.`,
    '',
    'COMO RESPONDER',
    '- Português do Brasil, direto e cordial. Primeira linha: a resposta com o número principal em **negrito**.',
    '- Depois, no máximo 6 linhas de detalhe: lista curta ou tabela em markdown quando comparar pessoas ou períodos.',
    '- Use SOMENTE os dados abaixo. Nunca invente número, nome ou data. Se o dado não existir, diga qual falta e onde a equipe consegue (Imoview, agenda, painel).',
    '- Quando houver RASCUNHO CALCULADO PELO PAINEL, os números dele são a verdade: mantenha-os e acrescente o que as outras fontes dizem.',
    '- Anotações da equipe são fatos da casa: cite como "segundo anotação de <autor> em <data>".',
    '- Termine, se fizer sentido, com uma sugestão prática de próximo passo em uma linha.',
    '- Não use travessões.',
    '',
    rascunho ? `RASCUNHO CALCULADO PELO PAINEL\n${rascunho}\n` : '',
    'DADOS DO PAINEL (Supabase, recorte de quem pergunta)',
    JSON.stringify(fatos || {}),
    '',
    'DADOS DO WHATSAPP E DA GABI',
    JSON.stringify(servidor || {}),
    '',
    memorias.length ? `ANOTAÇÕES DA EQUIPE\n${memorias.map((m) => `- [${data(m.criadaEm)}${m.autor ? ` · ${m.autor}` : ''}] ${m.texto}`).join('\n')}` : 'ANOTAÇÕES DA EQUIPE\n(nenhuma)',
    '',
    perguntasRecentes.length
      ? `PERGUNTAS RECENTES DA EQUIPE (contexto do que costumam acompanhar)\n${perguntasRecentes.map((p) => `- ${data(p.ts)} ${p.autor}: ${p.pergunta}`).join('\n')}`
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Números do lado do servidor: conversas, origens, encaminhamentos, visitas da Gabi. */
function contextoServidor({ conversas, visitas, eventos, catalogoStatus, funil, agora = Date.now() }) {
  const lista = Object.values(conversas).filter((c) => c && c.fone && !/^simulacao|^site/.test(c.fone) && (c.historico || []).length);
  const em = (dias) => lista.filter((c) => (c.atualizadaEm || 0) >= agora - dias * 86400000);
  const porFonte = {};
  for (const c of em(30)) porFonte[c.fonte || 'whatsapp direto'] = (porFonte[c.fonte || 'whatsapp direto'] || 0) + 1;
  const esperando = lista.filter((c) => c.encaminhamento && !c.encaminhamento.respondidoEm);
  const respostas = (eventos || []).filter((e) => e.tipo === 'resposta_humana' && Date.parse(e.ts || 0) >= agora - 30 * 86400000);
  const minutos = respostas.map((e) => e.dados && e.dados.minutos).filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  const v30 = (visitas || []).filter((v) => Date.parse(v.criadaEm || 0) >= agora - 30 * 86400000);
  return {
    conversas_whatsapp: { total: lista.length, ativas_7_dias: em(7).length, ativas_30_dias: em(30).length, por_origem_30_dias: porFonte },
    esperando_resposta_da_equipe: esperando.slice(0, 10).map((c) => ({ nome: c.nome || 'Cliente', ha_horas: Math.round((agora - c.encaminhamento.ts) / 3600000) })),
    tempo_primeira_resposta_humana_mediana_min: minutos.length ? minutos[Math.floor(minutos.length / 2)] : null,
    visitas_marcadas_pela_gabi_30_dias: v30.length,
    visitas_gabi_por_status: v30.reduce((a, v) => ((a[v.status] = (a[v.status] || 0) + 1), a), {}),
    pos_visita: v30.filter((v) => v.posVisita).map((v) => ({ codigo: v.codigo, nota: v.posVisita.nota || null, resposta: v.posVisita.resposta ? String(v.posVisita.resposta).slice(0, 160) : null })).slice(0, 10),
    carteira_imoview: catalogoStatus,
    funil_gabi_30_dias: funil,
  };
}

module.exports = { Cerebro, montarSistema, contextoServidor };
