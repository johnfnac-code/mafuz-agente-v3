'use strict';
// Testes de unidade das peças novas (não precisam de Imoview, Z-API nem LLM).
// Rode: node --test test/unidades.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gabi-'));
const { config } = require('../src/config');
const radar = require('../src/radar');
const { Agenda } = require('../src/agenda');
const { argumentosFfmpeg, textos } = require('../src/video');
const { comUtm } = require('../src/agent');
const { fotosDe } = require('../src/catalogo');

const casa = (extra = {}) => ({
  codigo: '17560', tipo: 'Casa em condomínio', grupo: 'casa', finalidade: 'venda', bairro: 'Alphaville Lagoa dos Ingleses',
  bairroNorm: 'alphaville lagoa dos ingleses', cidade: 'Nova Lima', preco: 4200000, preco_formatado: 'R$ 4.200.000',
  dormitorios: 4, suites: 4, vagas: 4, area_m2: 480, url: 'https://mafuz.site/imovel/abc', ...extra,
});

test('radar: registra perfil só com recorte concreto', () => {
  const conv = {};
  assert.equal(radar.registrarPerfil(conv, { texto_livre: 'piscina' }), false);
  assert.equal(radar.registrarPerfil(conv, { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'], preco_max: 5000000 }), true);
  assert.deepEqual(conv.radar.filtros.bairros, ['Alphaville']);
});

test('radar: combina respeita tipo, região, preço (10%) e quartos', () => {
  const f = { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'], preco_max: 4000000, dormitorios_min: 4 };
  assert.equal(radar.combina(casa(), f), true); // 4,2 mi cabe na tolerância de 10%
  assert.equal(radar.combina(casa({ preco: 4600000 }), f), false);
  assert.equal(radar.combina(casa({ grupo: 'apartamento' }), f), false);
  assert.equal(radar.combina(casa({ bairroNorm: 'vila da serra', bairro: 'Vila da Serra' }), f), false);
  assert.equal(radar.combina(casa({ dormitorios: 3 }), f), false);
  assert.equal(radar.combina(casa({ finalidade: 'locacao' }), f), false);
});

test('radar: planeja respeitando opt-out, intervalo, validade e duplicidade', () => {
  const agora = Date.now();
  const base = { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'] };
  const convs = [
    { fone: '1', atualizadaEm: agora, radar: { filtros: base } },
    { fone: '2', atualizadaEm: agora, optOut: true, radar: { filtros: base } },
    { fone: '3', atualizadaEm: agora, radar: { filtros: base, ultimoEnvio: agora - 3600000 } },
    { fone: '4', atualizadaEm: agora - 90 * 86400000, radar: { filtros: base } },
    { fone: '5', atualizadaEm: agora, radar: { filtros: base, enviados: ['17560:novo'] } },
  ];
  const planos = radar.planejar(convs, { novos: [casa()] }, { intervaloHoras: 20, validadeDias: 60 }, agora);
  assert.deepEqual(planos.map((p) => p.conv.fone), ['1']);
  const msg = radar.mensagem({ nome: 'Paula Souza' }, planos[0].itens);
  assert.match(msg, /Oi, Paula!/);
  assert.doesNotMatch(msg, /[—–]/);
});

test('UTM: acrescenta parâmetros sem duplicar', () => {
  const u = comUtm('https://mafuz.site/imovel/abc', 'radar', config);
  assert.match(u, /utm_source=whatsapp&utm_medium=gabi&utm_campaign=radar/);
  assert.equal(comUtm(u, 'outra', config), u);
});

test('catálogo: fotos do Imoview em url, urlm ou urlp', () => {
  assert.deepEqual(fotosDe({ fotos: [{ url: 'https://a/1.jpg' }, { urlm: 'https://a/2.jpg' }, { x: 1 }, 'https://a/3.jpg'] }), [
    'https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg',
  ]);
});

test('vídeo: 15 s exatos com 3, 4 ou 5 fotos e textos sem travessão', () => {
  for (const n of [3, 4, 5]) {
    const { total, args } = argumentosFfmpeg(Array.from({ length: n }, (_, i) => `/tmp/f${i}.jpg`), casa(), '/tmp/s.mp4');
    assert.ok(Math.abs(total - 15) < 0.05, `total ${total} com ${n} fotos`);
    assert.ok(args.includes('libx264'));
  }
  const t = textos(casa());
  assert.equal(t.preco, 'R$ 4.200.000');
  assert.match(t.medidas, /4 quartos/);
});

test('agenda: horários livres respeitam ocupação da agenda e janela de visitas', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const conta = { client_email: 'gabi@mafuz.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const cfg = {
    ...config,
    agenda: { ...config.agenda, contaServico: JSON.stringify(conta), corretores: [{ fone: '5531989097232', email: 'marcella@mafuz.com.br' }], duracaoMin: 60, diasAFrente: 3 },
    equipe: { ...config.equipe, venda: ['5531989097232'], locacao: [] },
  };
  // Segunda 29/09/2026 08:00 em Brasília; ocupado 09:00 a 12:00.
  const agora = new Date('2026-09-29T11:00:00Z');
  const ocupado = [{ start: '2026-09-29T09:00:00-03:00', end: '2026-09-29T12:00:00-03:00' }];
  const fetchImpl = async (url) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ calendars: { 'marcella@mafuz.com.br': { busy: ocupado } } }) };
  };
  const ag = new Agenda(cfg, { fetchImpl });
  assert.equal(ag.ativa(), true);
  const slots = await ag.horariosLivres({ carteira: 'venda', data: '2026-09-29', periodo: 'manha' }, agora);
  assert.ok(slots.length > 0);
  for (const s of slots.filter((x) => x.data === '2026-09-29')) {
    const h = +s.hora.slice(0, 2);
    assert.ok(h >= 13, `slot ${s.hora} colide com o bloco ocupado (margem de 30 min)`);
  }
  assert.match(slots[0].rotulo, /às \d+h$/);
});

// ---------------- v2.3: resumo das 8h, pós-visita, 2º Cérebro, Instagram ----------------
const rotinas = require('../src/rotinas');
const { Cerebro, montarSistema, contextoServidor } = require('../src/cerebro');
const { Instagram } = require('../src/instagram');

// Sábado, 26/09/2026, 08:05 em Brasília (11:05 UTC).
const SAB_8H = new Date('2026-09-26T11:05:00Z');

test('resumo das 8h: visitas do dia, clientes esperando e novos na carteira da carteira certa', () => {
  const conversas = {
    '5531911111111': { fone: '5531911111111', nome: 'Ana Souza', carteira: 'venda', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000 } },
    '5531922222222': { fone: '5531922222222', nome: 'Bruno', carteira: 'locacao', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000 } },
    '5531933333333': { fone: '5531933333333', nome: 'Carla', carteira: 'venda', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000, respondidoEm: 1 } },
  };
  const visitas = [
    { fone: '5531911111111', nome: 'Ana Souza', codigo: '17560', bairro: 'Alphaville', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao' },
    { fone: '5531922222222', nome: 'Bruno', codigo: '9000', bairro: 'Lourdes', data: '2026-09-26', hora: '11:00', status: 'aguardando_confirmacao' },
    { fone: '5531911111111', nome: 'Ana Souza', codigo: '1', data: '2026-09-27', hora: '10:00', status: 'aguardando_confirmacao' },
  ];
  const novos = [casa({ codigo: '20001' }), casa({ codigo: '20002', finalidade: 'locacao' })];
  const r = rotinas.resumoCorretor({ nome: 'Marcella Lima', carteira: 'venda', visitas, conversas, novos, carteiraDe: (c) => c.carteira, painelUrl: 'https://mafuz.site/painel?tab=conversas', agora: SAB_8H });
  assert.match(r.texto, /^Bom dia, Marcella\. Seu resumo das 8h · sábado, 26\/09/);
  assert.equal(r.visitas, 1);
  assert.match(r.texto, /10:00 · Ana Souza · cód\. 17560/);
  assert.doesNotMatch(r.texto, /Bruno/);
  assert.equal(r.esperando, 1);
  assert.equal(r.novos, 1);
  assert.match(r.texto, /cód\. 20001/);
  assert.doesNotMatch(r.texto, /[—–]/);
});

test('resumo das 8h: roda uma vez por dia, só na hora e nos dias configurados', () => {
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: null }), true);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: '2026-09-26' }), false);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 9, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: null }), false);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5], ultimoEnvio: null }), false);
});

test('pós-visita: só visitas confirmadas pela equipe, 2 h depois e sem repetir', () => {
  const agora = new Date('2026-09-26T17:30:00Z'); // 14:30 em Brasília
  const reservada = '2026-09-25T15:00:00Z';
  const conversas = {
    a: { fone: 'a', nome: 'Ana', historico: [{ papel: 'equipe', ts: Date.parse('2026-09-25T16:00:00Z') }] },
    b: { fone: 'b', nome: 'Bia', historico: [{ papel: 'agente', ts: Date.parse('2026-09-25T16:00:00Z') }] },
    c: { fone: 'c', nome: 'Caio', historico: [] },
  };
  const visitas = [
    { id: 'V1', fone: 'a', codigo: '1', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao', criadaEm: reservada },
    { id: 'V2', fone: 'b', codigo: '2', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao', criadaEm: reservada },
    { id: 'V3', fone: 'c', codigo: '3', data: '2026-09-26', hora: '10:00', status: 'confirmada', criadaEm: reservada },
    { id: 'V4', fone: 'a', codigo: '4', data: '2026-09-26', hora: '13:30', status: 'confirmada', criadaEm: reservada },
    { id: 'V5', fone: 'a', codigo: '5', data: '2026-09-26', hora: '10:00', status: 'cancelada', criadaEm: reservada },
    { id: 'V6', fone: 'a', codigo: '6', data: '2026-09-26', hora: '10:00', status: 'confirmada', criadaEm: reservada, posVisita: { enviadaEm: 'x' } },
  ];
  const prontas = rotinas.visitasParaPosVisita({ visitas, conversas, agora, horasDepois: 2 }).map((v) => v.id);
  assert.deepEqual(prontas, ['V1', 'V3']);
  const msgs = rotinas.mensagemPosVisita({ codigo: '17560', bairro: 'Alphaville' }, { nome: 'Ana Souza' });
  assert.match(msgs[0], /^Oi, Ana! Aqui é a Gabi, da MAFUZ\. Como foi a visita ao imóvel no Alphaville \(cód\. 17560\)\?/);
  assert.match(msgs[1], /De 1 a 5/);
});

test('2º Cérebro: guarda, prioriza e esquece anotações; monta contexto sem inventar', () => {
  const c = new Cerebro(process.env.DATA_DIR);
  const a = c.lembrar('Proprietário da cobertura do Belvedere aceita permuta até R$ 2 mi', 'Fernando');
  c.lembrar('Reunião de equipe toda segunda às 9h', 'Fernando');
  assert.equal(c.relevantes('permuta na cobertura')[0].id, a.id);
  const c2 = new Cerebro(process.env.DATA_DIR);
  assert.equal(c2.memorias.length, 2, 'persiste em disco');
  assert.ok(c2.esquecer(a.id));
  const sis = montarSistema({ fatos: { leads: { semana: 12 } }, rascunho: '**12 leads nesta semana.**', servidor: {}, memorias: c2.memorias, perguntasRecentes: [], usuario: { nome: 'Fernando', papeis: ['agency'] }, agora: SAB_8H });
  assert.match(sis, /RASCUNHO CALCULADO PELO PAINEL\n\*\*12 leads/);
  assert.match(sis, /Nunca invente/);
  assert.match(sis, /Reunião de equipe/);
  const ctx = contextoServidor({
    conversas: { x: { fone: '5531', historico: [{}], atualizadaEm: SAB_8H.getTime(), fonte: 'instagram', encaminhamento: { ts: SAB_8H.getTime() - 7200000 } } },
    visitas: [], eventos: [{ tipo: 'resposta_humana', ts: SAB_8H.toISOString(), dados: { minutos: 12 } }], catalogoStatus: {}, funil: {}, agora: SAB_8H.getTime(),
  });
  assert.equal(ctx.conversas_whatsapp.por_origem_30_dias.instagram, 1);
  assert.equal(ctx.esperando_resposta_da_equipe[0].ha_horas, 2);
  assert.equal(ctx.tempo_primeira_resposta_humana_mediana_min, 12);
});

test('Instagram: normaliza vídeos, fotos e álbuns da API', () => {
  const v = Instagram.normalizar({ id: '1', media_type: 'VIDEO', media_url: 'https://v.mp4', thumbnail_url: 'https://t.jpg', permalink: 'https://instagram.com/p/1', caption: 'Casa no Alphaville\nsegunda linha', timestamp: '2026-09-20' });
  assert.deepEqual(v, { id: '1', tipo: 'video', midia: 'https://v.mp4', capa: 'https://t.jpg', link: 'https://instagram.com/p/1', legenda: 'Casa no Alphaville', data: '2026-09-20' });
  assert.equal(Instagram.normalizar({ id: '2', media_type: 'IMAGE', media_url: 'https://i.jpg' }).capa, 'https://i.jpg');
  assert.equal(new Instagram({ token: '', dir: process.env.DATA_DIR }).ativo(), false);
});
