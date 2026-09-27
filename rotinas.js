'use strict';
// Rotinas da equipe: o resumo das 8h de cada corretor e o pós-visita automático.
// Funções puras (recebem o estado e devolvem o que enviar) para serem testáveis;
// o server.js decide quando rodar e faz o envio.

const { partesSP, formatarBRL } = require('./util');

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Visitas são marcadas no horário de Brasília (UTC-3, sem horário de verão).
const tsVisita = (v) => Date.parse(`${v.data}T${String(v.hora || '12:00').padStart(5, '0')}:00-03:00`);

const primeiroNome = (s) => String(s || '').trim().split(/\s+/)[0] || '';

/**
 * Resumo das 8h para um corretor.
 * @param {object} p
 * @param {string} p.nome        nome do corretor
 * @param {'venda'|'locacao'} p.carteira
 * @param {object[]} p.visitas   store.visitas
 * @param {object} p.conversas   store.conversas
 * @param {object[]} p.novos     imóveis que entraram na carteira nas últimas 24h
 * @param {(conv:object)=>string} p.carteiraDe
 * @param {string} p.painelUrl
 * @param {Date} [p.agora]
 */
function resumoCorretor({ nome, carteira, visitas, conversas, novos, carteiraDe, painelUrl, agora = new Date() }) {
  const hoje = partesSP(agora);
  const doDia = visitas
    .filter((v) => v.data === hoje.iso && v.status !== 'cancelada')
    .filter((v) => {
      const c = conversas[v.fone];
      return !c || carteiraDe(c) === carteira;
    })
    .sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  const esperando = Object.values(conversas)
    .filter((c) => c && c.encaminhamento && !c.encaminhamento.respondidoEm && carteiraDe(c) === carteira)
    .filter((c) => agora.getTime() - c.encaminhamento.ts > 15 * 60000 && agora.getTime() - c.encaminhamento.ts < 7 * 86400000)
    .sort((a, b) => a.encaminhamento.ts - b.encaminhamento.ts);

  const naCarteira = (novos || []).filter((i) => (carteira === 'locacao' ? /loca|alug/i.test(i.finalidade || '') : !/loca|alug/i.test(i.finalidade || '')));

  const linhas = [];
  linhas.push(`Bom dia${nome ? `, ${primeiroNome(nome)}` : ''}. Seu resumo das 8h · ${DIAS[hoje.diaSemana]}, ${String(hoje.dia).padStart(2, '0')}/${String(hoje.mes).padStart(2, '0')}`);
  linhas.push('');
  if (doDia.length) {
    linhas.push(`📅 Visitas de hoje (${doDia.length})`);
    for (const v of doDia.slice(0, 8)) linhas.push(`${v.hora} · ${v.nome || 'Cliente'} · cód. ${v.codigo}${v.bairro ? ` · ${v.bairro}` : ''}`);
  } else {
    linhas.push('📅 Nenhuma visita marcada pela Gabi para hoje.');
  }
  linhas.push('');
  if (esperando.length) {
    linhas.push(`⏳ Clientes esperando retorno (${esperando.length})`);
    for (const c of esperando.slice(0, 6)) {
      const horas = Math.round((agora.getTime() - c.encaminhamento.ts) / 3600000);
      linhas.push(`${c.nome || 'Cliente'} · há ${horas < 1 ? 'menos de 1 h' : `${horas} h`} · wa.me/${c.fone}`);
    }
  } else {
    linhas.push('✅ Nenhum cliente esperando retorno.');
  }
  if (naCarteira.length) {
    linhas.push('');
    linhas.push(`🏡 Novos na carteira desde ontem (${naCarteira.length})`);
    for (const i of naCarteira.slice(0, 5)) linhas.push(`cód. ${i.codigo} · ${i.tipo || 'Imóvel'} · ${i.bairro || ''} · ${i.preco_formatado || formatarBRL(i.preco)}`);
  }
  if (painelUrl) {
    linhas.push('');
    linhas.push(`Conversas ao vivo: ${painelUrl}`);
  }
  return { texto: linhas.join('\n'), visitas: doDia.length, esperando: esperando.length, novos: naCarteira.length };
}

/** Deve rodar o resumo agora? Uma vez por dia, na hora marcada, nos dias da regra. */
function horaDoResumo({ agora = new Date(), hora = 8, dias = [1, 2, 3, 4, 5, 6], ultimoEnvio }) {
  const p = partesSP(agora);
  if (!dias.includes(p.diaSemana)) return false;
  if (p.hora !== hora) return false;
  return ultimoEnvio !== p.iso;
}

/**
 * Visitas prontas para o pós-visita: aconteceram há pelo menos `horasDepois`,
 * no máximo há 2 dias, não foram canceladas, ainda não receberam a mensagem e
 * foram confirmadas por alguém da equipe (mensagem do corretor na conversa
 * depois da reserva, ou status "confirmada").
 */
function visitasParaPosVisita({ visitas, conversas, agora = new Date(), horasDepois = 2 }) {
  const t = agora.getTime();
  return visitas.filter((v) => {
    if (!v || v.posVisita || v.status === 'cancelada') return false;
    const quando = tsVisita(v);
    if (!Number.isFinite(quando)) return false;
    if (t < quando + horasDepois * 3600000 || t > quando + 2 * 86400000) return false;
    const conv = conversas[v.fone];
    if (!conv || conv.optOut) return false;
    if (v.status === 'confirmada') return true;
    const reservada = Date.parse(v.criadaEm || 0) || 0;
    return (conv.historico || []).some((h) => h.papel === 'equipe' && h.ts > reservada);
  });
}

function mensagemPosVisita(v, conv) {
  const nome = primeiroNome(conv && conv.nome ? conv.nome : v.nome);
  return [
    `Oi${nome ? `, ${nome}` : ''}! Aqui é a Gabi, da MAFUZ. Como foi a visita ao imóvel${v.bairro ? ` no ${v.bairro}` : ''} (cód. ${v.codigo})?`,
    'De 1 a 5, quanto ele combinou com o que você procura? Se faltou alguma coisa, me conta o quê que eu separo opções mais certeiras.',
  ];
}

module.exports = { resumoCorretor, horaDoResumo, visitasParaPosVisita, mensagemPosVisita, tsVisita };
