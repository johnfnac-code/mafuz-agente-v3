'use strict';
// Radar MAFUZ: quando entra na carteira (ou baixa de preço) um imóvel com o perfil
// que o cliente pediu à Gabi, ela avisa no WhatsApp.
//
// O perfil é o último recorte de busca da conversa (finalidade, tipo, cidade,
// bairros, faixa de preço, quartos, suítes, vagas e área). Regras de respeito:
// nada fora da janela de envio, no máximo um aviso a cada N horas por cliente,
// nunca para quem pediu para parar, nunca durante atendimento humano, e o
// perfil expira depois de N dias sem conversa.

const { norm } = require('./util');
const { Imoview } = require('./imoview');

const CAMPOS = ['finalidade', 'tipo', 'cidade', 'bairros', 'preco_min', 'preco_max', 'dormitorios_min', 'suites_min', 'vagas_min', 'area_min'];

/** Guarda o perfil de busca da conversa (chamado a cada buscar_imoveis). */
function registrarPerfil(conv, args) {
  const f = {};
  for (const c of CAMPOS) {
    const v = args && args[c];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    f[c] = v;
  }
  // Perfil útil precisa de finalidade e de pelo menos um recorte concreto.
  const concreto = f.tipo || f.cidade || (f.bairros && f.bairros.length) || f.preco_max || f.dormitorios_min;
  if (!concreto) return false;
  if (!f.finalidade) f.finalidade = 'venda';
  conv.radar = { ...(conv.radar || {}), filtros: f, atualizadoEm: Date.now(), enviados: (conv.radar && conv.radar.enviados) || [] };
  return true;
}

/** O imóvel combina com o perfil? Tolerância de 10% no preço. */
function combina(item, f) {
  if (!item || !f) return false;
  if (f.finalidade && item.finalidade !== f.finalidade) return false;
  if (f.tipo && item.grupo !== Imoview.grupoTipo(f.tipo)) return false;
  if (f.cidade && !norm(item.cidade || '').includes(norm(f.cidade))) return false;
  if (f.bairros && f.bairros.length) {
    const alvo = [item.bairroNorm || norm(item.bairro || ''), norm(item.condominio || '')].join(' ');
    if (!f.bairros.some((b) => b && alvo.includes(norm(b)))) return false;
  }
  if (f.preco_max && (!item.preco || item.preco > f.preco_max * 1.1)) return false;
  if (f.preco_min && item.preco && item.preco < f.preco_min * 0.9) return false;
  if (f.dormitorios_min && (item.dormitorios || 0) < f.dormitorios_min) return false;
  if (f.suites_min && (item.suites || 0) < f.suites_min) return false;
  if (f.vagas_min && (item.vagas || 0) < f.vagas_min) return false;
  if (f.area_min && item.area_m2 && item.area_m2 < f.area_min * 0.9) return false;
  return true;
}

/**
 * Para cada conversa elegível, os imóveis (novos ou com preço menor) que combinam.
 * Devolve [{ conv, itens: [{ item, motivo }] }].
 */
function planejar(conversas, { novos = [], baixas = [] }, opcoes, agora = Date.now()) {
  const { intervaloHoras = 20, maxImoveis = 2, validadeDias = 60, podeReceber = () => true } = opcoes || {};
  const candidatos = [
    ...novos.map((item) => ({ item, motivo: 'novo' })),
    ...baixas.map((b) => ({ item: b.item, motivo: 'baixou', de: b.de })),
  ];
  if (!candidatos.length) return [];
  const planos = [];
  for (const conv of conversas) {
    const r = conv && conv.radar;
    if (!r || !r.filtros || conv.optOut) continue;
    if (agora - (conv.atualizadaEm || r.atualizadoEm || 0) > validadeDias * 86400000) continue;
    if (r.ultimoEnvio && agora - r.ultimoEnvio < intervaloHoras * 3600000) continue;
    if (!podeReceber(conv)) continue;
    const enviados = new Set(r.enviados || []);
    const itens = candidatos
      .filter((c) => !enviados.has(`${c.item.codigo}:${c.motivo}`) && combina(c.item, r.filtros))
      .slice(0, maxImoveis);
    if (itens.length) planos.push({ conv, itens });
  }
  return planos;
}

/** Texto do aviso (sem travessão, no tom da Gabi). */
function mensagem(conv, itens) {
  const nome = conv.nome ? `, ${conv.nome.split(' ')[0]}` : '';
  const baixou = itens.every((i) => i.motivo === 'baixou');
  const intro = baixou
    ? `Oi${nome}! Um imóvel com o perfil que você me pediu acabou de ter o valor reduzido. Achei que você ia querer saber primeiro.`
    : itens.length > 1
      ? `Oi${nome}! Entraram agora na carteira da Mafuz dois imóveis com o perfil que você me pediu. Separei para você ver antes de todo mundo.`
      : `Oi${nome}! Acabou de entrar na carteira da Mafuz um imóvel com o perfil que você me pediu. Separei para você ver antes de todo mundo.`;
  return `${intro}\n\nQuer que eu agende uma visita? Se preferir não receber esses avisos, é só me dizer.`;
}

module.exports = { registrarPerfil, combina, planejar, mensagem, CAMPOS };
