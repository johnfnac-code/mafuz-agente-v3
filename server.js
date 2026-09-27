'use strict';
// Servidor da assistente de WhatsApp da Mafuz (Gabi).
// Z-API (webhook) -> fila com agrupamento de mensagens -> agente (LLM + Imoview) -> Z-API.

const http = require('http');
const { config, validar } = require('./config');
const { Store } = require('./store');
const { ZApi, mascarar } = require('./zapi');
const { SiteLinks } = require('./site');
const { Imoview } = require('./imoview');
const { LLM } = require('./llm');
const { Agente } = require('./agent');
const { Catalogo } = require('./catalogo');
const { Agenda } = require('./agenda');
const { Videos } = require('./video');
const radar = require('./radar');
const rotinas = require('./rotinas');
const { Cerebro, montarSistema, contextoServidor } = require('./cerebro');
const { Instagram } = require('./instagram');
const fs = require('fs');
const { log, digitos, dentroDoHorario, foneExibicao, sleep, partesSP } = require('./util');

const VERSAO = '2.4.0';
const inicio = Date.now();
let ultimoWebhookImoview = 0;
let webhookImoviewAgendado = null;

const store = new Store(config.dataDir, { conversaTtlDias: config.comportamento.conversaTtlDias });
const zapi = new ZApi(config.zapi);
const site = new SiteLinks(config.site);
const imoview = new Imoview(config.imoview, site, config.comportamento.limiteAltoTicket);
const llm = new LLM({ ...config.llm, modeloTranscricao: config.comportamento.modeloTranscricao });
const catalogo = new Catalogo({ imoview, site, config });
const agenda = new Agenda(config);
const videos = new Videos(config, { imoview });
const agente = new Agente({ config, store, zapi, imoview, llm, catalogo, agenda });
const cerebro = new Cerebro(config.dataDir);
const instagram = new Instagram({ token: config.instagram.token, dir: config.dataDir, perfil: config.instagram.perfil });

// Novidades da carteira: vídeo vertical dos imóveis novos e Radar MAFUZ.
catalogo.aoAtualizar = async ({ novos, baixas }) => {
  videos.enfileirar(novos);
  planejarRadar({ novos, baixas });
};

// Rastro dos últimos webhooks recebidos e do que foi decidido com cada um (diagnóstico em /admin/estado).
const rastro = [];
function rastrear(p, decisao, extra = {}) {
  rastro.push({
    ts: new Date().toISOString(),
    fone: p && p.phone ? String(p.phone).slice(-6) : '',
    tipo: p && p.type,
    fromMe: !!(p && p.fromMe),
    fromApi: !!(p && p.fromApi),
    texto: p && p.text && p.text.message ? String(p.text.message).slice(0, 30) : '',
    decisao,
    ...extra,
  });
  if (rastro.length > 200) rastro.splice(0, rastro.length - 200);
}

// ---------------- telefones ----------------
// Compara números brasileiros ignorando 55 e o 9º dígito (o WhatsApp às vezes omite).
function chaveFone(f) {
  let d = digitos(f);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : d;
}
const mesmoFone = (a, b) => chaveFone(a) === chaveFone(b);
const internos = () => [...config.equipe.admins, ...config.equipe.alertas, ...config.equipe.venda, ...config.equipe.locacao];
const ehInterno = (fone) => internos().some((x) => mesmoFone(x, fone));
// Modo teste: um número da equipe passa a conversar com o agente como se fosse cliente
// (comandos com # continuam funcionando). Ligado/desligado por #teste.
const emModoTeste = (fone) => !!(store.global.testers && store.global.testers[chaveFone(fone)]);

function botAtivo() {
  return store.global.botAtivo === null || store.global.botAtivo === undefined ? config.comportamento.botAtivo : store.global.botAtivo;
}

function acharConversa(foneDigitado) {
  const alvo = digitos(foneDigitado);
  if (!alvo) return null;
  const chave = Object.keys(store.conversas).find((k) => mesmoFone(k, alvo));
  if (chave) return chave;
  return alvo.length <= 11 ? '55' + alvo : alvo;
}

// ---------------- fila por cliente (agrupa mensagens quebradas) ----------------
const filas = new Map();

function enfileirar(fone, item) {
  let f = filas.get(fone);
  if (!f) {
    f = { itens: [], timer: null, rodando: false };
    filas.set(fone, f);
  }
  f.itens.push(item);
  clearTimeout(f.timer);
  // Espera o cliente terminar de digitar (tempo base + variação, para não soar automático).
  const espera = config.comportamento.debounceMs + Math.round(Math.random() * config.comportamento.debounceVariacaoMs);
  f.timer = setTimeout(() => processarFila(fone), espera);
}

async function processarFila(fone) {
  const f = filas.get(fone);
  if (!f) return;
  f.timer = null;
  if (f.rodando) return; // o término da rodada atual reagenda
  const itens = f.itens.splice(0);
  if (!itens.length) return filas.delete(fone);
  f.rodando = true;
  try {
    await atender(fone, itens);
  } catch (e) {
    log('atender_erro', { fone: mascarar(fone), erro: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
  } finally {
    f.rodando = false;
    if (f.itens.length && !f.timer) f.timer = setTimeout(() => processarFila(fone), 1500);
    else if (!f.itens.length && !f.timer) filas.delete(fone);
  }
}

async function montarTexto(itens, conv) {
  const partes = [];
  let audio = false;
  for (const it of itens) {
    if (it.nome && !conv.nome) conv.nome = limparNome(it.nome);
    if (it.audioUrl) {
      audio = true;
      let transcrito = null;
      if (config.comportamento.transcreverAudio) {
        try {
          const r = await fetch(it.audioUrl, { signal: AbortSignal.timeout(30000) });
          if (r.ok) transcrito = await llm.transcrever(Buffer.from(await r.arrayBuffer()), it.mime || 'audio/ogg');
        } catch (e) {
          log('transcricao_erro', { erro: e.message });
        }
      }
      partes.push(transcrito ? `[áudio] ${transcrito}` : '[o cliente enviou um áudio que não pôde ser transcrito; peça com gentileza que escreva]');
    } else if (it.midia && !it.texto) {
      partes.push(`[o cliente enviou ${it.midia} sem texto]`);
    } else if (it.texto) {
      partes.push(it.texto);
    }
  }
  return { texto: partes.join('\n').trim(), audio };
}

function limparNome(n) {
  const s = String(n || '')
    .replace(/[^\p{L}\s'.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 ? s.split(' ').slice(0, 3).join(' ').slice(0, 60) : '';
}

async function detectarOrigem(conv, texto) {
  // Mensagem padrão do site: "Sou {nome} e tenho interesse neste imóvel: ... 🔖 Código: 17095"
  // De onde o cliente veio (para o funil). Vale a primeira pista.
  if (!conv.fonte) {
    const t = texto.toLowerCase();
    conv.fonte = /vim pelo site|mafuz\.site|site da mafuz|pelo site/.test(t)
      ? 'site'
      : /instagram|\binsta\b|reels|stories/.test(t)
        ? 'instagram'
        : /facebook|an[uú]ncio|patrocinad/.test(t)
          ? 'anúncio'
          : /c[óo]d(igo|\.)?\s*[:#]?\s*\d{2,7}/i.test(texto)
            ? 'ficha de imóvel'
            : /zap ?im[oó]veis|viva ?real|olx|imovelweb|chaves na m[aã]o/.test(t)
              ? 'portal'
              : 'whatsapp direto';
  }
  const nome = texto.match(/\bSou ([A-ZÀ-Ý][\p{L}'-]+(?: [A-ZÀ-Ý][\p{L}'-]+){0,3})/u);
  if (nome) conv.nome = limparNome(nome[1]);
  let m = texto.match(/c[óo]d(?:igo|\.)?\s*[:#]?\s*(\d{2,7})\b/i);
  if (!m) {
    const cod = site.codigoDoLink(texto);
    if (cod) m = [cod, cod];
  }
  if (!m || (conv.origem && conv.origem.codigo === m[1])) return;
  try {
    const ficha = await imoview.detalhar(m[1]);
    if (ficha) {
      conv.origem = { codigo: ficha.codigo, titulo: `${ficha.tipo}, ${ficha.bairro}, ${ficha.preco_formatado}`, url: ficha.url };
      agente.registrarImoveis(conv, [ficha]);
      conv.qualificacao.codigo_imovel_interesse = conv.qualificacao.codigo_imovel_interesse || ficha.codigo;
      if (ficha.finalidade) conv.qualificacao.finalidade = conv.qualificacao.finalidade || (/loca/i.test(ficha.finalidade) ? 'alugar' : 'comprar');
    }
  } catch (e) {
    log('origem_erro', { erro: e.message });
  }
}

// Ritmo humano: "digitando..." proporcional ao tamanho (2 a 6 s, com variação), no máximo
// MAX_MENSAGENS textos por resposta e os imóveis em cartões separados (foto + legenda + link).
function tempoDigitando(texto) {
  const base = 2 + Math.min(4, String(texto).length / 70);
  return Math.max(2, Math.min(6, Math.round(base + (Math.random() - 0.5))));
}

async function fotoEmBase64(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf.length > 4.5 * 1024 * 1024) return null;
    const tipo = buf[0] === 0x89 ? 'image/png' : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
    return `data:${tipo};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function enviarCartao(fone, cartao) {
  agente.marcarEnviado(fone, cartao.legenda);
  // Vídeo vertical do imóvel, quando já existe e este servidor tem endereço público.
  const video = config.video.enviarNoWhatsApp ? videos.url(cartao.codigo) : null;
  if (video) {
    try {
      await zapi.enviarVideo(fone, video, cartao.legenda, { delayTyping: 2 });
      return;
    } catch (e) {
      log('cartao_video_erro', { codigo: cartao.codigo, erro: e.message });
    }
  }
  if (config.comportamento.enviarFotos) {
    // Foto direto do Imoview; o banco do site fica como segunda opção.
    const doCatalogo = (catalogo.porCodigo.get(String(cartao.codigo)) || {}).fotos || [];
    const foto = doCatalogo[0] || (await site.capa(cartao.codigo, cartao.url));
    const imagem = foto ? await fotoEmBase64(foto) : null;
    if (imagem) {
      try {
        await zapi.enviarImagem(fone, imagem, cartao.legenda, { delayTyping: 2 });
        return;
      } catch (e) {
        log('cartao_foto_erro', { codigo: cartao.codigo, erro: e.message });
      }
    }
  }
  await zapi.enviarTexto(fone, cartao.legenda, { delayTyping: 2 });
}

async function enviarResposta(fone, texto, cartoes = []) {
  let partes = String(texto || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const max = Math.max(1, config.comportamento.maxMensagens);
  if (partes.length > max) partes = [...partes.slice(0, max - 1), partes.slice(max - 1).join('\n\n')];
  const enviarTxt = async (p) => {
    agente.marcarEnviado(fone, p);
    await zapi.enviarTexto(fone, p, { delayTyping: tempoDigitando(p) });
  };
  if (!cartoes.length) {
    for (const p of partes) await enviarTxt(p);
    return;
  }
  // Com imóveis: introdução, cartões e, por último, a pergunta de continuação.
  let antes = partes;
  let depois = [];
  if (partes.length >= 2) {
    antes = [partes[0]];
    depois = partes.slice(1);
  } else if (partes.length === 1 && /\?\s*$/.test(partes[0])) {
    antes = [];
    depois = partes;
  }
  for (const p of antes) await enviarTxt(p);
  for (const c of cartoes) await enviarCartao(fone, c);
  for (const p of depois) await enviarTxt(p);
}

async function atender(fone, itens) {
  const conv = store.conversa(fone);
  const { texto, audio } = await montarTexto(itens, conv);
  if (!texto) return;
  if (store.pausado(fone) || !botAtivo()) {
    store.adicionarHistorico(conv, 'cliente', texto);
    return;
  }

  const primeira = conv.historico.length === 0;
  const optOut = RE_OPTOUT.test(texto);
  if (optOut) conv.optOut = true;
  else if (conv.optOut && conv.historico.length && /\b(quero|procuro|tem|gostaria|pode)\b/i.test(texto)) conv.optOut = false;
  await detectarOrigem(conv, texto);
  registrarRespostaPosVisita(conv, texto);
  conv.turnosCliente += 1;
  conv.turnosSemAvanco += 1;
  const sinais = {
    primeiraMensagem: primeira,
    audio,
    negociacao: agente.detectarNegociacao(texto),
    limiteTurnos: conv.turnosSemAvanco >= config.comportamento.maxTurnosSemAvanco,
    optOut,
  };

  // Falha do modelo: tenta de novo em silêncio; se falhar outra vez, avisa o cliente com gentileza,
  // alerta a equipe e segue disponível (o agente nunca fica mudo por conta de um erro).
  let resposta;
  for (let tentativa = 1; tentativa <= 3 && !resposta; tentativa++) {
    try {
      resposta = await agente.responder(conv, texto, sinais);
    } catch (e) {
      log('llm_erro', { fone: mascarar(fone), tentativa, erro: e.message });
      if (tentativa < 3) await sleep(2500 * tentativa);
    }
  }
  store.adicionarHistorico(conv, 'cliente', texto);

  if (!resposta) {
    const msg = 'Me dá só um minutinho, estou confirmando isso para você e já te respondo por aqui.';
    await enviarResposta(fone, msg).catch(() => {});
    store.adicionarHistorico(conv, 'agente', msg);
    await agente
      .alertarEquipe(`⚠️ FALHA TÉCNICA: a ${config.agente.nome} não conseguiu responder agora.\nCliente: ${conv.nome || 'sem nome'} · ${foneExibicao(fone)}\nhttps://wa.me/${fone}\nÚltima mensagem: "${texto.slice(0, 300)}"\nSe puder, responda o cliente pelo WhatsApp da Mafuz.`)
      .catch(() => {});
    return;
  }

  const enviarAlertas = async () => {
    for (const a of resposta.turno.alertas || []) {
      try {
        await agente.alertarEquipe(a.montar(), a.carteira);
      } catch (e) {
        log('alerta_erro', { erro: e.message });
      }
    }
  };

  // Se alguém da equipe assumiu enquanto o modelo pensava, não envia ao cliente.
  if (store.pausado(fone) && !resposta.turno.transferiu) {
    log('resposta_descartada_humano_assumiu', { fone: mascarar(fone) });
    return enviarAlertas();
  }
  if (resposta.texto || resposta.turno.cartoes.length) {
    const registro = [resposta.texto, ...resposta.turno.cartoes.map((c) => `[imóvel enviado com foto] ${c.legenda.replace(/\*/g, '')}`)].filter(Boolean).join('\n\n');
    store.adicionarHistorico(conv, 'agente', registro);
    await enviarResposta(fone, resposta.texto, resposta.turno.cartoes);
  }
  await enviarAlertas();
  store.evento('resposta', { fone, ferramentas: resposta.turno.ferramentas });
}

// ---------------- comandos da equipe ----------------
async function comando(fone, texto) {
  const [cmd, ...resto] = texto.trim().split(/\s+/);
  const arg = resto.join(' ');
  let r;
  switch (cmd.toLowerCase()) {
    case '#status': {
      const dia = Date.now() - 86400000;
      const ativas = Object.values(store.conversas).filter((c) => c.atualizadaEm > dia).length;
      const pausadas = Object.values(store.conversas).filter((c) => c.pausadoAte > Date.now());
      const leadsHoje = Object.values(store.leads).filter((l) => Date.parse(l.atualizadoEm) > dia).length;
      const visitas = store.visitas.filter((v) => v.status === 'aguardando_confirmacao').length;
      r = [
        `${config.agente.nome} ${botAtivo() ? 'LIGADA' : 'DESLIGADA'} · modo ${config.comportamento.modo}${emModoTeste(fone) ? ' · você está em MODO TESTE' : ''}`,
        `Carteira carregada: ${catalogo.itens.length} imóveis`,
        `Conversas nas últimas 24h: ${ativas}`,
        `Leads atualizados nas últimas 24h: ${leadsHoje}`,
        `Pedidos de visita registrados: ${visitas}`,
        `Reengajamentos nas últimas 24h: ${store.eventos.filter((e) => e.tipo === 'reengajamento' && Date.parse(e.ts) > dia).length}`,
        `Radar: ${store.eventos.filter((e) => e.tipo === 'radar' && Date.parse(e.ts) > dia).length} aviso(s) em 24h · ${Object.values(store.conversas).filter((c) => c && c.radar && c.radar.filtros).length} perfis ativos`,
        `Vídeos gerados: ${videos.lista().length} · Agenda Google: ${agenda.ativa() ? 'conectada' : 'não conectada'}`,
        `Em silêncio (humano atendendo): ${pausadas.length}${pausadas.length ? '\n' + pausadas.slice(0, 10).map((c) => `- ${c.nome || ''} ${foneExibicao(c.fone)}`).join('\n') : ''}`,
      ].join('\n');
      break;
    }
    case '#pausar': {
      const alvo = acharConversa(arg);
      if (!alvo) r = 'Use: #pausar 5531999999999';
      else {
        store.pausar(alvo, 24 * 30, 'pausado_pela_equipe');
        r = `Ok. O assistente não responde mais ${foneExibicao(alvo)} até alguém mandar #retomar ${alvo}.`;
      }
      break;
    }
    case '#retomar': {
      const alvo = acharConversa(arg);
      if (!alvo) r = 'Use: #retomar 5531999999999';
      else {
        store.conversa(alvo);
        store.retomar(alvo);
        r = `Ok. O assistente volta a responder ${foneExibicao(alvo)} na próxima mensagem do cliente.`;
      }
      break;
    }
    case '#teste': {
      store.global.testers = store.global.testers || {};
      const chave = chaveFone(fone);
      const ligar = /off|desliga|sair|parar/i.test(arg) ? false : /on|liga/i.test(arg) ? true : !store.global.testers[chave];
      if (ligar) store.global.testers[chave] = true;
      else delete store.global.testers[chave];
      store.tocar();
      r = ligar
        ? `Modo teste LIGADO: a partir de agora você conversa com a ${config.agente.nome} como se fosse um cliente (os alertas também chegam aqui). Para recomeçar do zero: #reset. Para sair: #teste off`
        : 'Modo teste DESLIGADO: este número volta a ser só da equipe (alertas e comandos).';
      break;
    }
    case '#reset': {
      const alvo = arg ? acharConversa(arg) : Object.keys(store.conversas).find((k) => mesmoFone(k, fone)) || fone;
      delete store.conversas[alvo];
      delete store.leads[alvo];
      store.visitas = store.visitas.filter((v) => !mesmoFone(v.fone, alvo));
      store.tocar();
      r = `Conversa de ${foneExibicao(alvo)} apagada. A próxima mensagem começa um atendimento novo.`;
      break;
    }
    case '#desligar':
      store.global.botAtivo = false;
      store.tocar();
      r = 'Assistente DESLIGADO para todos os clientes. O número segue funcionando normalmente para a equipe. Para religar: #ligar';
      break;
    case '#ligar':
      store.global.botAtivo = true;
      store.tocar();
      r = 'Assistente LIGADO.';
      break;
    case '#leads': {
      const l = Object.values(store.leads)
        .sort((a, b) => Date.parse(b.atualizadoEm) - Date.parse(a.atualizadoEm))
        .slice(0, 8);
      r = l.length
        ? l.map((x) => `${x.temperatura || '-'} · ${x.nome || 'sem nome'} · ${foneExibicao(x.fone)} · ${agente.resumoBusca(x.qualificacao || {})}`).join('\n')
        : 'Nenhum lead ainda.';
      break;
    }
    default:
      r = 'Comandos: #status · #leads · #pausar <número> · #retomar <número> · #desligar · #ligar · #teste (conversar com o agente como cliente) · #reset (apagar sua conversa de teste)';
  }
  agente.marcarEnviado(fone, r);
  await zapi.enviarTexto(fone, r).catch((e) => log('comando_erro', { erro: e.message }));
  store.evento('comando', { de: fone, cmd });
}

// ---------------- webhook Z-API ----------------
async function processarWebhook(p) {
  if (!p || typeof p !== 'object') return;
  if (p.type && p.type !== 'ReceivedCallback') return; // status, presença etc.
  if (p.isGroup || p.isNewsletter || p.broadcast || p.isStatusReply) return rastrear(p, 'ignorado: grupo/canal/status');
  if (p.isEdit) return rastrear(p, 'ignorado: mensagem editada');
  if (p.reaction || p.notification) return rastrear(p, 'ignorado: reação/notificação');
  const fone = digitos(p.phone);
  if (!fone || fone.length < 10) return rastrear(p, 'ignorado: telefone inválido');
  if (store.jaProcessado(p.messageId)) return rastrear(p, 'ignorado: repetida');

  const texto = (
    (p.text && p.text.message) ||
    (p.image && p.image.caption) ||
    (p.video && p.video.caption) ||
    (p.document && p.document.caption) ||
    (p.buttonsResponseMessage && p.buttonsResponseMessage.message) ||
    (p.listResponseMessage && (p.listResponseMessage.title || p.listResponseMessage.message)) ||
    (p.hydratedTemplate && p.hydratedTemplate.message) ||
    ''
  ).trim();

  // Mensagem que saiu do próprio número da Mafuz.
  if (p.fromMe) {
    if (p.fromApi || agente.foiEnviadoPorNos(fone, texto)) return rastrear(p, 'enviada pela assistente');
    if (ehInterno(fone)) return rastrear(p, 'enviada para a equipe');
    // Alguém da equipe respondeu pelo celular / WhatsApp Web: a assistente se cala nesta conversa.
    // A cada mensagem do corretor, o silêncio recomeça; sem nova mensagem por PAUSA_HUMANO_MIN, a Gabi volta.
    store.pausarMin(fone, config.comportamento.pausaHumanoMin, 'humano_assumiu');
    const convH = store.conversa(fone);
    convH.humanoAssumiuEm = Date.now();
    if (texto) store.adicionarHistorico(convH, 'equipe', texto, { autor: 'equipe (celular)' });
    // Tempo de resposta da equipe: primeira mensagem humana depois de um encaminhamento.
    if (convH.encaminhamento && !convH.encaminhamento.respondidoEm) {
      convH.encaminhamento.respondidoEm = Date.now();
      store.evento('resposta_humana', { fone, minutos: Math.round((Date.now() - convH.encaminhamento.ts) / 60000), motivo: convH.encaminhamento.motivo });
    }
    const f = filas.get(fone);
    if (f) {
      clearTimeout(f.timer);
      f.itens = [];
    }
    log('humano_assumiu', { fone: mascarar(fone) });
    store.evento('humano_assumiu', { fone });
    return rastrear(p, 'corretor assumiu: assistente em silêncio');
  }

  if (ehInterno(fone)) {
    if (texto.startsWith('#')) {
      rastrear(p, 'comando da equipe');
      return comando(fone, texto);
    }
    if (!emModoTeste(fone)) return rastrear(p, 'ignorado: número da equipe (use #teste para conversar)');
  }

  const item = { texto, nome: p.senderName || p.chatName || '', ts: p.momment || Date.now() };
  if (p.audio && p.audio.audioUrl) Object.assign(item, { audioUrl: p.audio.audioUrl, mime: p.audio.mimeType });
  else if (!texto) {
    if (p.image) item.midia = 'uma imagem';
    else if (p.video) item.midia = 'um vídeo';
    else if (p.document) item.midia = 'um documento';
    else if (p.sticker) item.midia = 'uma figurinha';
    else if (p.location) item.midia = 'uma localização';
    else if (p.contact) item.midia = 'um contato';
    else return rastrear(p, p.waitingMessage ? 'ignorado: WhatsApp ainda aguardando a mensagem' : 'ignorado: sem texto');
  }

  if (!botAtivo()) return rastrear(p, 'ignorado: assistente desligada');
  if (config.comportamento.modo === 'fora_do_horario' && dentroDoHorario(config.comportamento.horario)) {
    return rastrear(p, 'ignorado: horário comercial');
  }
  if (store.pausado(fone)) {
    const conv = store.conversa(fone);
    if (item.texto) store.adicionarHistorico(conv, 'cliente', item.texto);
    return rastrear(p, 'ignorado: corretor atendendo');
  }
  rastrear(p, 'na fila para responder');
  enfileirar(fone, item);
}

// ---------------- reengajamento (cutucada de 15 min e follow-ups) ----------------
const RE_OPTOUT = /\b(pare de (me )?(mandar|enviar)|n[aã]o (me )?(mande|envie) mais|n[aã]o quero mais (mensagens?|receber)|n[aã]o tenho (mais )?interesse|sem interesse|me (remova|tire) d|descadastr|sair da lista|stop)\b/i;

function janelaAberta(data = new Date()) {
  return dentroDoHorario(config.reengajamento.janelaRegras, data);
}

function tipoReengajamento(conv, agora = Date.now()) {
  const R = config.reengajamento;
  const esc = R.escala;
  const h = conv.historico || [];
  if (!h.length || conv.optOut || (conv.visitas || []).length) return null;
  const ultima = h[h.length - 1];
  if (ultima.papel !== 'agente') return null;
  const ultCliente = [...h].reverse().find((x) => x.papel === 'cliente');
  if (!ultCliente) return null;
  if (conv.humanoAssumiuEm && conv.humanoAssumiuEm > ultCliente.ts) return null;
  conv.reeng = conv.reeng || { cutucadaDe: 0, followups: {} };
  const desdeAgente = agora - ultima.ts;
  const desdeCliente = agora - ultCliente.ts;
  const dia = 86400000 * esc;
  const dias = [...R.followupDias].sort((a, b) => b - a);
  for (const d of dias) {
    if (desdeCliente >= d * dia && conv.reeng.followups[d] !== ultCliente.ts) {
      const anterior = dias.filter((x) => x < d);
      const faltaAnterior = anterior.length && conv.reeng.followups[anterior[0]] !== ultCliente.ts;
      if (faltaAnterior) continue;
      return { tipo: d === Math.min(...R.followupDias) ? 'followup3' : 'followup7', marcar: () => (conv.reeng.followups[d] = ultCliente.ts) };
    }
  }
  const min = 60000 * esc;
  if (
    !conv.reeng.cutucadaDe &&
    desdeAgente >= R.cutucadaMin * min &&
    desdeAgente < 180 * min &&
    /\?\s*$/.test(ultima.texto.split('\n\n').pop() || '')
  ) {
    return { tipo: 'cutucada', marcar: () => (conv.reeng.cutucadaDe = ultCliente.ts) };
  }
  return null;
}

let reengajandoAgora = false;
async function cicloReengajamento() {
  if (!config.reengajamento.ativo || reengajandoAgora || !botAtivo()) return;
  if (!janelaAberta()) return;
  reengajandoAgora = true;
  try {
    for (const conv of Object.values(store.conversas)) {
      if (!conv || !conv.fone || /^simulacao|^site/.test(conv.fone)) continue;
      if (store.pausado(conv.fone)) continue;
      if (ehInterno(conv.fone) && !emModoTeste(conv.fone)) continue;
      const f = filas.get(conv.fone);
      if (f && (f.rodando || f.itens.length)) continue;
      const alvo = tipoReengajamento(conv);
      if (!alvo) continue;
      alvo.marcar();
      store.tocar();
      await reengajarConversa(conv, alvo.tipo);
    }
  } catch (e) {
    log('reengajamento_erro', { erro: e.message });
  } finally {
    reengajandoAgora = false;
  }
}

async function reengajarConversa(conv, tipo) {
  try {
    const r = await agente.reengajar(conv, tipo);
    if (!r.texto && !r.turno.cartoes.length) return false;
    const registro = [r.texto, ...r.turno.cartoes.map((c) => `[imóvel enviado com foto] ${c.legenda.replace(/\*/g, '')}`)].filter(Boolean).join('\n\n');
    store.adicionarHistorico(conv, 'agente', registro);
    await enviarResposta(conv.fone, r.texto, r.turno.cartoes);
    store.evento('reengajamento', { fone: conv.fone, tipo });
    log('reengajamento', { fone: mascarar(conv.fone), tipo });
    return true;
  } catch (e) {
    log('reengajamento_falha', { fone: mascarar(conv.fone), tipo, erro: e.message });
    return false;
  }
}

// ---------------- Radar MAFUZ ----------------
function podeReceberRadar(conv) {
  if (!conv || !conv.fone || /^simulacao|^site/.test(conv.fone)) return false;
  if (ehInterno(conv.fone) && !emModoTeste(conv.fone)) return false;
  if (store.pausado(conv.fone)) return false;
  return true;
}

// Chamado quando a carteira muda: guarda o aviso na conversa; o envio respeita a janela.
function planejarRadar(novidades) {
  if (!config.radar.ativo) return 0;
  const planos = radar.planejar(Object.values(store.conversas), novidades, { ...config.radar, podeReceber: podeReceberRadar });
  for (const { conv, itens } of planos) {
    conv.radar.pendentes = [...(conv.radar.pendentes || []), ...itens.map((i) => ({ codigo: i.item.codigo, motivo: i.motivo, de: i.de || null }))].slice(-config.radar.maxImoveis);
  }
  if (planos.length) {
    store.tocar();
    log('radar_planejado', { clientes: planos.length });
  }
  return planos.length;
}

let radarRodando = false;
async function cicloRadar() {
  if (!config.radar.ativo || radarRodando || !botAtivo() || !janelaAberta()) return;
  radarRodando = true;
  try {
    for (const conv of Object.values(store.conversas)) {
      const r = conv && conv.radar;
      if (!r || !r.pendentes || !r.pendentes.length || conv.optOut || !podeReceberRadar(conv)) continue;
      if (r.ultimoEnvio && Date.now() - r.ultimoEnvio < config.radar.intervaloHoras * 3600000) continue;
      const f = filas.get(conv.fone);
      if (f && (f.rodando || f.itens.length)) continue;
      await enviarRadar(conv);
    }
  } catch (e) {
    log('radar_erro', { erro: e.message });
  } finally {
    radarRodando = false;
  }
}

async function enviarRadar(conv) {
  const r = conv.radar;
  const itens = (r.pendentes || [])
    .map((p) => ({ ...p, item: catalogo.porCodigo.get(p.codigo) }))
    .filter((p) => p.item && p.item.url);
  r.pendentes = [];
  if (!itens.length) return false;
  agente.registrarImoveis(conv, itens.map((p) => p.item));
  const cartoes = itens.map((p) => ({
    codigo: p.item.codigo,
    url: p.item.url,
    legenda: agente.legendaImovel(
      p.item,
      p.motivo === 'baixou' && p.de ? `Valor reduzido: de ${p.de.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })} para ${p.item.preco_formatado}` : 'Acabou de entrar na carteira',
      'radar'
    ),
  }));
  const texto = radar.mensagem(conv, itens);
  r.enviados = [...(r.enviados || []), ...itens.map((p) => `${p.item.codigo}:${p.motivo}`)].slice(-200);
  r.ultimoEnvio = Date.now();
  store.adicionarHistorico(conv, 'agente', [texto, ...cartoes.map((c) => `[imóvel enviado com foto] ${c.legenda.replace(/\*/g, '')}`)].join('\n\n'));
  try {
    await enviarResposta(conv.fone, texto, cartoes);
    store.evento('radar', { fone: conv.fone, codigos: itens.map((p) => p.item.codigo) });
    log('radar_enviado', { fone: mascarar(conv.fone), imoveis: itens.length });
    return true;
  } catch (e) {
    log('radar_falha', { fone: mascarar(conv.fone), erro: e.message });
    return false;
  }
}

// ---------------- resumo das 8h e pós-visita ----------------
function novosDesdeOntem(agora = new Date()) {
  const ontem = new Date(agora.getTime() - 86400000).toISOString().slice(0, 10);
  return catalogo.itens.filter((i) => i.cadastro && i.cadastro >= ontem);
}

function planejarResumos(agora = new Date()) {
  const painelUrl = `${config.site.url.replace(/\/$/, '')}/painel?tab=conversas`;
  const envios = [];
  for (const [carteira, fones] of [['venda', config.equipe.venda], ['locacao', config.equipe.locacao]]) {
    for (const fone of fones) {
      const r = rotinas.resumoCorretor({
        nome: config.nomesCorretores[digitos(fone)] || '',
        carteira,
        visitas: store.visitas,
        conversas: store.conversas,
        novos: novosDesdeOntem(agora),
        carteiraDe: (c) => agente.carteiraDe(c, null),
        painelUrl,
        agora,
      });
      envios.push({ fone, carteira, ...r });
    }
  }
  return envios;
}

let resumoRodando = false;
async function cicloResumo(agora = new Date()) {
  if (!config.resumo.ativo || resumoRodando) return;
  if (!rotinas.horaDoResumo({ agora, hora: config.resumo.hora, dias: config.resumo.dias, ultimoEnvio: store.global.resumoEnviadoEm })) return;
  resumoRodando = true;
  try {
    store.global.resumoEnviadoEm = partesSP(agora).iso;
    store.tocar();
    for (const e of planejarResumos(agora)) {
      try {
        await zapi.enviarTexto(e.fone, e.texto, { delayTyping: 1 });
        store.evento('resumo_8h', { fone: mascarar(e.fone), visitas: e.visitas, esperando: e.esperando, novos: e.novos });
        await sleep(1500);
      } catch (err) {
        log('resumo_erro', { fone: mascarar(e.fone), erro: err.message });
      }
    }
  } finally {
    resumoRodando = false;
  }
}

let posVisitaRodando = false;
async function cicloPosVisita(agora = new Date()) {
  if (!config.posVisita.ativo || posVisitaRodando || !botAtivo() || !janelaAberta(agora)) return;
  posVisitaRodando = true;
  try {
    const prontas = rotinas.visitasParaPosVisita({ visitas: store.visitas, conversas: store.conversas, agora, horasDepois: config.posVisita.horasDepois });
    for (const v of prontas.slice(0, 5)) {
      const conv = store.conversas[v.fone];
      if (!conv || store.pausado(v.fone)) continue;
      const msgs = rotinas.mensagemPosVisita(v, conv);
      try {
        for (const m of msgs) {
          agente.marcarEnviado(v.fone, m);
          await zapi.enviarTexto(v.fone, m, { delayTyping: 3 });
          store.adicionarHistorico(conv, 'agente', m);
          await sleep(1200);
        }
        v.posVisita = { enviadaEm: new Date(agora).toISOString() };
        conv.posVisitaPendente = { id: v.id, ts: agora.getTime() };
        store.evento('pos_visita_enviada', { fone: mascarar(v.fone), id: v.id, codigo: v.codigo });
        store.tocar();
      } catch (e) {
        log('pos_visita_erro', { fone: mascarar(v.fone), erro: e.message });
      }
    }
  } finally {
    posVisitaRodando = false;
  }
}

// Resposta do cliente ao pós-visita: guarda nota e comentário e avisa a carteira.
function registrarRespostaPosVisita(conv, texto) {
  const pend = conv.posVisitaPendente;
  if (!pend) return;
  delete conv.posVisitaPendente;
  if (Date.now() - pend.ts > 48 * 3600000) return;
  const v = store.visitas.find((x) => x.id === pend.id);
  if (!v) return;
  const nota = (String(texto).match(/\b([1-5])\b/) || [])[1];
  v.posVisita = { ...(v.posVisita || {}), resposta: String(texto).slice(0, 600), nota: nota ? Number(nota) : null, respondidaEm: new Date().toISOString() };
  store.evento('pos_visita_resposta', { fone: mascarar(conv.fone), id: v.id, nota: v.posVisita.nota });
  store.tocar();
  const carteira = agente.carteiraDe(conv, null);
  agente
    .alertarEquipe(
      [
        `📝 PÓS-VISITA${v.posVisita.nota ? ` · nota ${v.posVisita.nota}/5` : ''}`,
        agente.cabecalhoCliente(conv),
        `Imóvel: cód. ${v.codigo}${v.bairro ? ` · ${v.bairro}` : ''} · visita em ${v.data.split('-').reverse().join('/')} às ${v.hora}`,
        `Resposta: "${String(texto).slice(0, 400)}"`,
        v.posVisita.nota && v.posVisita.nota <= 3 ? 'A Gabi vai oferecer alternativas; vale um contato seu hoje.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      carteira
    )
    .catch(() => {});
  if (config.imoview.enviarLeads) agente.enviarLeadImoview(conv, `Pós-visita cód. ${v.codigo}: ${String(texto).slice(0, 300)}`).catch(() => {});
}

// ---------------- funil (painel da gestão) ----------------
function funil(dias = 30) {
  const desde = Date.now() - dias * 86400000;
  const convs = Object.values(store.conversas).filter((c) => c && c.fone && !/^simulacao|^site/.test(c.fone) && (c.criadaEm || 0) >= desde && !ehInterno(c.fone));
  const ev = store.eventos.filter((e) => Date.parse(e.ts) >= desde);
  const conta = (f) => convs.filter(f).length;
  const origem = {};
  for (const c of convs) {
    const o = c.fonte || (c.origem ? 'ficha de imóvel' : 'whatsapp direto');
    origem[o] = (origem[o] || 0) + 1;
  }
  const respostas = ev.filter((e) => e.tipo === 'resposta_humana').map((e) => e.minutos).filter((m) => m >= 0).sort((a, b) => a - b);
  const mediana = respostas.length ? respostas[Math.floor(respostas.length / 2)] : null;
  const porCarteira = { venda: 0, locacao: 0 };
  for (const c of convs) if ((c.transferencias || []).length || (c.visitas || []).length) porCarteira[agente.carteiraDe(c, null)] += 1;
  return {
    periodo_dias: dias,
    conversas: convs.length,
    com_perfil_de_busca: conta((c) => c.radar && c.radar.filtros),
    encaminhadas_a_corretor: conta((c) => (c.transferencias || []).length > 0),
    visitas_pedidas: conta((c) => (c.visitas || []).length > 0),
    pediram_para_parar: conta((c) => c.optOut),
    origem,
    leads_por_carteira: porCarteira,
    tempo_resposta_equipe_min: { mediana, amostras: respostas.length, ate_15_min: respostas.filter((m) => m <= 15).length },
    avisos_radar: ev.filter((e) => e.tipo === 'radar').length,
    reengajamentos: ev.filter((e) => e.tipo === 'reengajamento').length,
    leads_do_site: ev.filter((e) => e.tipo === 'site_lead').length,
    videos_gerados: videos.lista().filter((v) => Date.parse(v.criadoEm) >= desde).length,
  };
}

function paginaFunil(f, token) {
  const linha = (rotulo, valor, total) => {
    const pct = total ? Math.round((valor / total) * 100) : 0;
    return `<div class="l"><span>${rotulo}</span><b>${valor}</b><i style="--p:${pct}%"></i><em>${total ? pct + '%' : ''}</em></div>`;
  };
  const origem = Object.entries(f.origem).sort((a, b) => b[1] - a[1]).map(([k, v]) => linha(k, v, f.conversas)).join('');
  const t = f.tempo_resposta_equipe_min;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Funil · Gabi MAFUZ</title>
<style>:root{--ink:#111110;--paper:#f8f7f4;--line:#d6d3cc;--mut:#6b6a66}@media(prefers-color-scheme:dark){:root{--ink:#f0efeb;--paper:#0f0f0e;--line:#2d2c2a;--mut:#9a9893}}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:32px 16px}main{max-width:880px;margin:auto}
h1{font-weight:300;letter-spacing:.2em;text-transform:uppercase;font-size:22px;margin:0 0 4px}p{color:var(--mut);margin:0 0 28px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:28px}
.k{background:var(--paper);padding:18px}.k b{display:block;font-size:30px;font-weight:300;font-variant-numeric:tabular-nums}.k span{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--mut)}
h2{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--mut);font-weight:500;margin:28px 0 10px}
.l{display:grid;grid-template-columns:1fr 60px 1fr 48px;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.l b{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
.l i{height:6px;background:linear-gradient(90deg,var(--ink) var(--p),var(--line) var(--p))}.l em{font-style:normal;color:var(--mut);font-size:12px;text-align:right}
form{margin-bottom:24px}select{background:var(--paper);color:var(--ink);border:1px solid var(--line);padding:6px 10px}</style></head><body><main>
<h1>Funil da Gabi</h1><p>WhatsApp e site · últimos ${f.periodo_dias} dias · atualizado ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
<form><input type="hidden" name="token" value="${token}"><select name="dias" onchange="this.form.submit()">${[7, 30, 90].map((d) => `<option ${d === f.periodo_dias ? 'selected' : ''} value="${d}">Últimos ${d} dias</option>`).join('')}</select></form>
<div class="g"><div class="k"><span>Conversas</span><b>${f.conversas}</b></div><div class="k"><span>Com perfil</span><b>${f.com_perfil_de_busca}</b></div><div class="k"><span>Com corretor</span><b>${f.encaminhadas_a_corretor}</b></div><div class="k"><span>Visitas pedidas</span><b>${f.visitas_pedidas}</b></div></div>
<h2>Funil</h2>${linha('Conversas', f.conversas, f.conversas)}${linha('Perfil de busca definido', f.com_perfil_de_busca, f.conversas)}${linha('Encaminhadas a corretor', f.encaminhadas_a_corretor, f.conversas)}${linha('Visita pedida', f.visitas_pedidas, f.conversas)}
<h2>Origem</h2>${origem || '<p>Sem conversas no período.</p>'}
<h2>Carteira</h2>${linha('Venda', f.leads_por_carteira.venda, f.leads_por_carteira.venda + f.leads_por_carteira.locacao)}${linha('Locação', f.leads_por_carteira.locacao, f.leads_por_carteira.venda + f.leads_por_carteira.locacao)}
<h2>Tempo de resposta da equipe</h2><div class="g"><div class="k"><span>Mediana</span><b>${t.mediana === null ? '·' : t.mediana + ' min'}</b></div><div class="k"><span>Até 15 min</span><b>${t.amostras ? Math.round((t.ate_15_min / t.amostras) * 100) + '%' : '·'}</b></div><div class="k"><span>Atendimentos medidos</span><b>${t.amostras}</b></div></div>
<h2>Automação</h2><div class="g"><div class="k"><span>Avisos do Radar</span><b>${f.avisos_radar}</b></div><div class="k"><span>Reengajamentos</span><b>${f.reengajamentos}</b></div><div class="k"><span>Leads do site</span><b>${f.leads_do_site}</b></div><div class="k"><span>Vídeos gerados</span><b>${f.videos_gerados}</b></div></div>
<p style="margin-top:28px">Conversão por corretor e leads do Imoview ficam no painel do site, aba Funil.</p></main></body></html>`;
}

function paginaVideos(token) {
  const itens = videos.lista();
  const cards = itens
    .map((v) => `<figure><video src="/video/${v.codigo}.mp4" controls muted playsinline preload="metadata"></video><figcaption><b>${v.titulo}</b><span>${v.preco || ''} · cód. ${v.codigo}</span><a href="/video/${v.codigo}.mp4" download>Baixar</a></figcaption></figure>`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vídeos · MAFUZ</title>
<style>body{margin:0;background:#0f0f0e;color:#f0efeb;font:15px/1.5 system-ui,sans-serif;padding:32px 16px}main{max-width:1100px;margin:auto}h1{font-weight:300;letter-spacing:.2em;text-transform:uppercase;font-size:22px}
p{color:#9a9893}form{display:flex;gap:8px;margin:18px 0 28px}input{flex:1;max-width:260px;background:#1a1a19;border:1px solid #2d2c2a;color:inherit;padding:10px}button{background:#f0efeb;color:#111;border:0;padding:10px 16px;letter-spacing:.14em;text-transform:uppercase;font-size:11px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px}figure{margin:0}video{width:100%;aspect-ratio:9/16;background:#000;object-fit:cover}figcaption{display:grid;gap:2px;padding-top:8px;font-size:13px}figcaption span{color:#9a9893}a{color:#f0efeb}</style></head>
<body><main><h1>Vídeos verticais</h1><p>Gerados sozinhos para cada imóvel novo da carteira. 1080×1920, 15 s, prontos para Reels e Stories.</p>
<form method="get"><input type="hidden" name="token" value="${token}"><input name="gerar" placeholder="Código do imóvel" inputmode="numeric"><button>Gerar agora</button></form>
<div class="g">${cards || '<p>Nenhum vídeo ainda. Eles aparecem aqui quando entra imóvel novo, ou gere um pelo código.</p>'}</div></main></body></html>`;
}

// ---------------- Conversas no painel (corretores e administração) ----------------
// O painel do site chama estas rotas com o token de login do Supabase. O servidor
// confere o token e o papel (broker, agency ou super_admin) antes de mostrar ou enviar.
const cacheSessoes = new Map();
async function autenticarPainel(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const token = m[1];
  const c = cacheSessoes.get(token);
  if (c && c.expira > Date.now()) return c.usuario;
  const base = config.site.supabaseUrl;
  const h = { apikey: config.site.supabaseAnonKey, Authorization: `Bearer ${token}` };
  try {
    const u = await fetch(`${base}/auth/v1/user`, { headers: h, signal: AbortSignal.timeout(8000) });
    if (!u.ok) return null;
    const user = await u.json();
    const [r, p] = await Promise.all([
      fetch(`${base}/rest/v1/user_roles?select=role&user_id=eq.${user.id}`, { headers: h }).then((x) => x.json()).catch(() => []),
      fetch(`${base}/rest/v1/profiles?select=full_name&user_id=eq.${user.id}`, { headers: h }).then((x) => x.json()).catch(() => []),
    ]);
    const papeis = (Array.isArray(r) ? r : []).map((x) => x.role);
    if (!papeis.some((x) => ['broker', 'agency', 'super_admin'].includes(x))) return null;
    const usuario = { id: user.id, email: user.email, nome: (Array.isArray(p) && p[0] && p[0].full_name) || user.email, papeis };
    cacheSessoes.set(token, { usuario, expira: Date.now() + 120000 });
    if (cacheSessoes.size > 500) cacheSessoes.clear();
    return usuario;
  } catch {
    return null;
  }
}

function statusConversa(conv) {
  if (conv.pausadoAte && conv.pausadoAte > Date.now()) return conv.motivoPausa === 'humano_assumiu' || conv.motivoPausa === 'painel' ? 'corretor' : 'pausada';
  return 'gabi';
}

function resumoConversa(conv) {
  const ult = conv.historico[conv.historico.length - 1] || null;
  return {
    fone: conv.fone,
    nome: conv.nome || '',
    exibicao: foneExibicao(conv.fone),
    ultima: ult ? { papel: ult.papel, texto: String(ult.texto).slice(0, 140), ts: ult.ts } : null,
    atualizadaEm: conv.atualizadaEm,
    status: statusConversa(conv),
    pausadaAte: conv.pausadoAte || 0,
    carteira: agente.carteiraDe(conv, null),
    fonte: conv.fonte || null,
    visitas: (conv.visitas || []).length,
    encaminhada: !!conv.encaminhamento && !conv.encaminhamento.respondidoEm,
  };
}

async function rotasPainel(req, res, url) {
  const origem = req.headers.origin || '';
  const permitida = config.site.origensChat.includes(origem) || config.site.origensChat.includes('*');
  const cors = {
    'Access-Control-Allow-Origin': permitida ? origem || '*' : config.site.url,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  const json = (status, obj) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const usuario = await autenticarPainel(req);
  if (!usuario) return json(401, { erro: 'Entre no painel com uma conta da equipe.' });

  const lista = () =>
    Object.values(store.conversas).filter((c) => c && c.fone && !/^simulacao|^site/.test(c.fone) && !ehInterno(c.fone) && c.historico && c.historico.length);

  if (req.method === 'GET' && url.pathname === '/painel/conversas') {
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const itens = lista()
      .filter((c) => !q || (c.nome || '').toLowerCase().includes(q) || c.fone.includes(q.replace(/\D/g, '') || '§'))
      .sort((a, b) => (b.atualizadaEm || 0) - (a.atualizadaEm || 0))
      .slice(0, 200)
      .map(resumoConversa);
    return json(200, { conversas: itens, agora: Date.now(), usuario: { nome: usuario.nome, papeis: usuario.papeis } });
  }

  if (req.method === 'GET' && url.pathname === '/painel/conversa') {
    const fone = acharConversa(url.searchParams.get('fone'));
    const conv = fone && store.conversas[fone];
    if (!conv) return json(404, { erro: 'Conversa não encontrada.' });
    const desde = +url.searchParams.get('desde') || 0;
    return json(200, {
      ...resumoConversa(conv),
      historico: conv.historico.filter((h) => h.ts > desde).map((h) => ({ papel: h.papel, texto: h.texto, ts: h.ts, autor: h.autor || null })),
      busca: conv.qualificacao || {},
      imoveis: Object.values(conv.imoveis || {}).slice(-6).map((i) => ({ codigo: i.codigo, tipo: i.tipo, bairro: i.bairro, preco: i.preco_formatado, url: i.url })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/painel/enviar') {
    let corpo = {};
    try {
      corpo = JSON.parse((await lerCorpo(req, 20 * 1024)) || '{}');
    } catch {}
    const fone = acharConversa(corpo.fone);
    const texto = String(corpo.texto || '').trim().slice(0, 3000);
    const conv = fone && store.conversas[fone];
    if (!conv || !texto) return json(400, { erro: 'Conversa ou mensagem vazia.' });
    try {
      agente.marcarEnviado(fone, texto);
      await zapi.enviarTexto(fone, texto, { delayTyping: 1 });
    } catch (e) {
      return json(502, { erro: `WhatsApp não enviou: ${e.message}` });
    }
    store.adicionarHistorico(conv, 'equipe', texto, { autor: usuario.nome });
    store.pausarMin(fone, config.comportamento.pausaHumanoMin, 'painel');
    conv.humanoAssumiuEm = Date.now();
    if (conv.encaminhamento && !conv.encaminhamento.respondidoEm) {
      conv.encaminhamento.respondidoEm = Date.now();
      store.evento('resposta_humana', { fone, minutos: Math.round((Date.now() - conv.encaminhamento.ts) / 60000), motivo: conv.encaminhamento.motivo });
    }
    store.evento('painel_resposta', { fone, autor: usuario.email });
    return json(200, { ok: true, conversa: resumoConversa(conv) });
  }

  if (req.method === 'POST' && url.pathname === '/painel/gabi') {
    let corpo = {};
    try {
      corpo = JSON.parse((await lerCorpo(req, 4 * 1024)) || '{}');
    } catch {}
    const fone = acharConversa(corpo.fone);
    const conv = fone && store.conversas[fone];
    if (!conv) return json(404, { erro: 'Conversa não encontrada.' });
    if (corpo.acao === 'pausar') store.pausar(fone, 24, 'painel');
    else store.retomar(fone);
    store.evento('painel_gabi', { fone, acao: corpo.acao, autor: usuario.email });
    return json(200, { ok: true, conversa: resumoConversa(conv) });
  }

  // ---- 2º Cérebro ----
  if (url.pathname === '/painel/cerebro/memorias') {
    if (req.method === 'GET') return json(200, { memorias: cerebro.memorias.slice(0, 200), conversas: lista().length });
    if (req.method === 'POST') {
      let corpo = {};
      try {
        corpo = JSON.parse((await lerCorpo(req, 8 * 1024)) || '{}');
      } catch {}
      const texto = String(corpo.texto || '').trim();
      if (!texto) return json(400, { erro: 'Anotação vazia.' });
      const memoria = cerebro.lembrar(texto, String(usuario.nome || '').split(' ')[0]);
      store.evento('cerebro_memoria', { autor: usuario.email });
      return json(200, { memoria });
    }
    if (req.method === 'DELETE') {
      const ok = cerebro.esquecer(String(url.searchParams.get('id') || ''));
      return json(ok ? 200 : 404, { ok });
    }
  }

  if (req.method === 'POST' && url.pathname === '/painel/cerebro') {
    let corpo = {};
    try {
      corpo = JSON.parse((await lerCorpo(req, 200 * 1024)) || '{}');
    } catch {}
    const pergunta = String(corpo.pergunta || '').trim().slice(0, 1500);
    if (!pergunta) return json(400, { erro: 'Pergunta vazia.' });
    const sistema = montarSistema({
      fatos: corpo.fatos || {},
      rascunho: corpo.rascunho ? String(corpo.rascunho).slice(0, 6000) : '',
      servidor: contextoServidor({
        conversas: store.conversas,
        visitas: store.visitas,
        eventos: store.eventos,
        catalogoStatus: catalogo.status(),
        funil: funil(30),
      }),
      memorias: cerebro.relevantes(pergunta, 50),
      perguntasRecentes: cerebro.perguntas.slice(0, 15),
      usuario,
    });
    const historico = (Array.isArray(corpo.historico) ? corpo.historico : [])
      .slice(-10)
      .map((m) => ({ role: m.papel === 'voce' ? 'user' : 'assistant', content: String(m.texto || '').slice(0, 3000) }))
      .filter((m) => m.content);
    if (!historico.length || historico[historico.length - 1].role !== 'user') historico.push({ role: 'user', content: pergunta });
    try {
      const r = await llm.conversar({ sistema, mensagens: historico, ferramentas: [] });
      const resposta = String(r.texto || '').replace(/\s[—–]\s/g, ', ').trim();
      if (!resposta) return json(502, { erro: 'A IA não respondeu.' });
      cerebro.registrarPergunta(pergunta, resposta, String(usuario.nome || '').split(' ')[0]);
      store.evento('cerebro_pergunta', { autor: usuario.email });
      return json(200, { resposta });
    } catch (e) {
      log('cerebro_erro', { erro: e.message });
      return json(502, { erro: 'A IA está indisponível agora.' });
    }
  }
  return json(404, { erro: 'rota' });
}

// Situação da conexão do WhatsApp na Z-API (consultada no máximo a cada 60 s).
let statusWhats = { valor: 'não verificado', ts: 0 };
async function situacaoWhatsApp() {
  if (Date.now() - statusWhats.ts < 60000) return statusWhats.valor;
  try {
    const st = await zapi.status();
    statusWhats = { valor: st && st.connected && st.smartphoneConnected !== false ? 'conectado' : 'DESCONECTADO: reconecte pelo QR Code na Z-API', ts: Date.now() };
  } catch (e) {
    statusWhats = { valor: `erro ao consultar a Z-API: ${e.message.slice(0, 120)}`, ts: Date.now() };
  }
  if (!/^conectado/.test(statusWhats.valor)) log('whatsapp_desconectado', { situacao: statusWhats.valor });
  return statusWhats.valor;
}

// ---------------- HTTP ----------------
function lerCorpo(req, limite = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > limite) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

function responderJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

// Limite simples do chat do site: 20 mensagens por minuto por IP.
const acessosSite = new Map();
function limiteSite(ip) {
  const agora = Date.now();
  const l = (acessosSite.get(ip) || []).filter((t) => agora - t < 60000);
  l.push(agora);
  acessosSite.set(ip, l);
  if (acessosSite.size > 5000) acessosSite.clear();
  return l.length <= 20;
}

function autorizadoAdmin(url) {
  return !!config.adminToken && url.searchParams.get('token') === config.adminToken;
}

function csv(linhas) {
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  return linhas.map((l) => l.map(esc).join(';')).join('\n');
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/painel/')) return rotasPainel(req, res, url);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return responderJson(res, 200, {
        ok: true,
        servico: `${config.agente.nome} (${config.agente.empresa}): agente WhatsApp`,
        carteira: catalogo.itens.length,
        carteira_no_imoview: catalogo.esperado,
        carteira_completa: catalogo.completa,
        whatsapp: await situacaoWhatsApp(),
        versao: VERSAO,
        assistente: botAtivo() ? 'ligado' : 'desligado',
        modo: config.comportamento.modo,
        provedor_llm: config.llm.provedor,
        conversas: Object.keys(store.conversas).length,
        no_ar_ha_min: Math.round((Date.now() - inicio) / 60000),
        config_faltando: validar(),
        carteira_atualizada_em: catalogo.ultimaSync,
        sincroniza_a_cada_min: config.catalogo.sincronizarACadaMin,
        radar: config.radar.ativo ? 'ligado' : 'desligado',
        agenda_google: agenda.ativa() ? `${config.agenda.corretores.length} corretor(es)` : 'não conectada',
        videos: { automatico: config.video.ativo, gerados: videos.lista().length, url_publica: !!config.video.urlPublica },
        resumo_8h: config.resumo.ativo ? `${config.resumo.hora}h` : 'desligado',
        pos_visita: config.posVisita.ativo ? `${config.posVisita.horasDepois}h depois` : 'desligado',
        cerebro: { memorias: cerebro.memorias.length },
        instagram: instagram.ativo() ? 'conectado' : 'sem token',
      });
    }

    // Vídeos e fotos do Instagram da MAFUZ para o site (cache de 30 min).
    if (url.pathname === '/site/instagram') {
      const origem = req.headers.origin || '';
      const permitida = config.site.origensChat.includes(origem) || config.site.origensChat.includes('*');
      const cors = { 'Access-Control-Allow-Origin': permitida ? origem || '*' : config.site.url, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const itens = await instagram.itens({ somenteVideos: url.searchParams.get('videos') === '1' });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
      return res.end(JSON.stringify({ perfil: config.instagram.perfil, ativo: instagram.ativo(), itens: itens.slice(0, 18) }));
    }

    // Chat da Gabi no site (mesmo cérebro do WhatsApp). Resposta em SSE, formato OpenAI.
    if (url.pathname === '/site/chat') {
      const origem = req.headers.origin || '';
      const permitida = config.site.origensChat.includes(origem) || config.site.origensChat.includes('*');
      const cors = {
        'Access-Control-Allow-Origin': permitida ? origem || '*' : config.site.url,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        Vary: 'Origin',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405, cors);
        return res.end();
      }
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limiteSite(ip)) {
        res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Muitas mensagens em pouco tempo. Tente de novo em um minuto.' }));
      }
      let corpo = {};
      try {
        corpo = JSON.parse((await lerCorpo(req, 200 * 1024)) || '{}');
      } catch {}
      let texto;
      try {
        texto = (await agente.responderSite(corpo.messages)).texto;
      } catch (e) {
        log('site_chat_erro', { erro: e.message });
        texto = 'Tive uma instabilidade agora. Pode repetir a pergunta? Se preferir, fale comigo pelo WhatsApp (31) 97537-7934.';
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: texto } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      store.evento('site_chat', { ip: ip.slice(0, 7) });
      return res.end();
    }

    // Leads do site (agendar visita, contato, venda seu imóvel, busca em 24h).
    // O site grava o lead no Supabase e avisa aqui: a equipe recebe o alerta no WhatsApp
    // na hora, pela carteira certa, e o lead entra no Imoview quando IMOVIEW_ENVIAR_LEADS=true.
    // Vídeos verticais (públicos: a Z-API e o Instagram precisam baixar).
    const mVideo = url.pathname.match(/^\/video\/(\d{1,8})\.mp4$/);
    if (req.method === 'GET' && mVideo) {
      const arq = videos.caminho(mVideo[1]);
      if (!fs.existsSync(arq)) {
        res.writeHead(404);
        return res.end();
      }
      const tam = fs.statSync(arq).size;
      const faixa = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (faixa) {
        const ini = faixa[1] ? +faixa[1] : 0;
        const fim = faixa[2] ? Math.min(+faixa[2], tam - 1) : tam - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${ini}-${fim}/${tam}`, 'Accept-Ranges': 'bytes', 'Content-Length': fim - ini + 1, 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': tam, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(arq).pipe(res);
    }

    // Webhook do Imoview (repassado pela função imoview-webhook): recarrega a carteira na hora.
    if (url.pathname === '/webhook/imoview') {
      if (!config.webhookSecret || url.searchParams.get('secret') !== config.webhookSecret) return responderJson(res, 401, { erro: 'secret inválido' });
      const desde = Date.now() - (ultimoWebhookImoview || 0);
      if (desde > 60000) {
        ultimoWebhookImoview = Date.now();
        catalogo.sincronizar().catch(() => undefined);
      } else if (!webhookImoviewAgendado) {
        webhookImoviewAgendado = setTimeout(() => {
          webhookImoviewAgendado = null;
          ultimoWebhookImoview = Date.now();
          catalogo.sincronizar().catch(() => undefined);
        }, 60000 - desde);
      }
      store.evento('webhook_imoview', {});
      return responderJson(res, 202, { ok: true, recarregando: true });
    }

    if (url.pathname === '/site/lead') {
      const origem = req.headers.origin || '';
      const permitida = config.site.origensChat.includes(origem) || config.site.origensChat.includes('*');
      const cors = {
        'Access-Control-Allow-Origin': permitida ? origem || '*' : config.site.url,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405, cors);
        return res.end();
      }
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limiteSite(ip)) {
        res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, erro: 'limite' }));
      }
      let l = {};
      try {
        l = JSON.parse((await lerCorpo(req, 20 * 1024)) || '{}');
      } catch {}
      const limpo = (v, n = 300) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
      const nome = limpo(l.nome, 80);
      const telefone = limpo(l.telefone, 30).replace(/[^\d+]/g, '');
      const email = limpo(l.email, 120);
      if (!nome || (!telefone && !email)) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, erro: 'nome e telefone ou e-mail são obrigatórios' }));
      }
      const carteira = /loca|alug/i.test(String(l.finalidade || '')) ? 'locacao' : 'venda';
      const origemLead = limpo(l.origem, 60) || 'site';
      const linhas = [
        `🔔 NOVO LEAD · ${carteira === 'locacao' ? 'LOCAÇÃO' : 'VENDA'} · site (${origemLead})`,
        `Nome: ${nome}`,
        telefone ? `WhatsApp: ${telefone} · wa.me/${telefone.replace(/\D/g, '')}` : '',
        email ? `E-mail: ${email}` : '',
        l.imovel ? `Imóvel: ${limpo(l.imovel, 200)}` : '',
        l.data ? `Visita: ${limpo(l.data, 60)}` : '',
        l.mensagem ? `Mensagem: ${limpo(l.mensagem, 600)}` : '',
      ].filter(Boolean);
      agente.alertarEquipe(linhas.join('\n'), carteira).catch(() => undefined);
      if (config.imoview.enviarLeads && telefone) {
        imoview
          .incluirLead({
            nome,
            telefone,
            email,
            finalidade: carteira,
            codigoImovel: l.codigo || undefined,
            anotacoes: [`Origem: site (${origemLead})`, l.mensagem ? limpo(l.mensagem, 600) : ''].filter(Boolean).join(' · '),
          })
          .catch((e) => log('site_lead_imoview_erro', { erro: e.message }));
      }
      store.evento('site_lead', { origem: origemLead, carteira });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'POST' && url.pathname === '/webhook/zapi') {
      if (!config.webhookSecret || url.searchParams.get('secret') !== config.webhookSecret) {
        return responderJson(res, 401, { erro: 'secret inválido' });
      }
      const corpo = await lerCorpo(req);
      responderJson(res, 200, { recebido: true });
      let p;
      try {
        p = JSON.parse(corpo || '{}');
      } catch {
        return;
      }
      processarWebhook(p).catch((e) => log('webhook_erro', { erro: e.message }));
      return;
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!autorizadoAdmin(url)) return responderJson(res, 401, { erro: 'token inválido' });

      if (url.pathname === '/admin/configurar-webhook') {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const destino = `${proto}://${host}/webhook/zapi?secret=${encodeURIComponent(config.webhookSecret)}`;
        const r = await zapi.configurarWebhook(destino, { notificarEnviadasPorMim: true });
        return responderJson(res, 200, { ok: true, webhook: destino.replace(config.webhookSecret, '••••'), zapi: r });
      }

      if (url.pathname === '/admin/diagnostico') {
        const out = {};
        try {
          out.zapi = await zapi.status();
        } catch (e) {
          out.zapi = { erro: e.message };
        }
        try {
          const r = await imoview.buscar({ finalidade: 'venda', cidade: 'Nova Lima', limite: 1 });
          out.imoview = { ok: true, total_venda_nova_lima: r.total_encontrado, exemplo: r.imoveis[0] && { codigo: r.imoveis[0].codigo, url: r.imoveis[0].url } };
        } catch (e) {
          out.imoview = { erro: e.message };
        }
        try {
          const r = await llm.conversar({ sistema: 'Responda apenas: ok', mensagens: [{ role: 'user', content: 'teste' }], ferramentas: [] });
          out.llm = { ok: true, provedor: config.llm.provedor, resposta: r.texto.slice(0, 40) };
        } catch (e) {
          out.llm = { erro: e.message };
        }
        return responderJson(res, 200, out);
      }

      // Conversa de teste com o modelo real, sem enviar nada pelo WhatsApp e sem alertar a equipe.
      // Ex.: /admin/simular?token=...&conversa=1&texto=oi   (&reset=1 apaga a conversa de teste)
      if (url.pathname === '/admin/simular') {
        const chave = 'simulacao-' + String(url.searchParams.get('conversa') || '1').replace(/\W/g, '').slice(0, 20);
        if (url.searchParams.get('reset')) delete store.conversas[chave];
        const texto = String(url.searchParams.get('texto') || '').trim();
        if (!texto) return responderJson(res, 200, { ok: true, conversa: chave, apagada: !!url.searchParams.get('reset') });
        const conv = store.conversa(chave);
        if (!conv.nome) conv.nome = String(url.searchParams.get('nome') || 'Cliente Teste');
        await detectarOrigem(conv, texto);
        const sinais = { primeiraMensagem: conv.historico.length === 0, negociacao: agente.detectarNegociacao(texto), simulacao: true };
        const t0 = Date.now();
        const r = await agente.responder(conv, texto, sinais);
        store.adicionarHistorico(conv, 'cliente', texto);
        store.adicionarHistorico(conv, 'agente', r.texto);
        delete store.leads[chave];
        store.visitas = store.visitas.filter((v) => v.fone !== chave);
        return responderJson(res, 200, {
          conversa: chave,
          segundos: Math.round((Date.now() - t0) / 100) / 10,
          mensagens: r.texto.split(/\n\s*\n/).map((m) => m.trim()).filter(Boolean),
          imoveis_com_foto: r.turno.cartoes.map((c) => c.legenda),
          ferramentas: r.turno.ferramentas,
          alertas_para_equipe: (r.turno.alertas || []).map((x) => ({ para: x.carteira || 'gestão', texto: x.montar() })),
        });
      }

      // Dispara um reengajamento agora (teste com o próprio número). Envia mensagem de verdade.
      // Ex.: /admin/reengajar?token=...&fone=5531999999999&tipo=cutucada|followup3|followup7
      if (url.pathname === '/admin/reengajar') {
        const alvo = acharConversa(url.searchParams.get('fone') || '');
        const conv = alvo && store.conversas[alvo];
        const tipo = String(url.searchParams.get('tipo') || 'cutucada');
        if (!conv) return responderJson(res, 404, { erro: 'conversa não encontrada' });
        if (!['cutucada', 'followup3', 'followup7'].includes(tipo)) return responderJson(res, 400, { erro: 'tipo inválido' });
        const ok = await reengajarConversa(conv, tipo);
        return responderJson(res, 200, { ok, tipo, fone: alvo });
      }

      if (url.pathname === '/admin/funil' || url.pathname === '/admin/funil.json') {
        const dias = [7, 30, 90].includes(+url.searchParams.get('dias')) ? +url.searchParams.get('dias') : 30;
        const f = funil(dias);
        if (url.pathname.endsWith('.json')) return responderJson(res, 200, f);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(paginaFunil(f, url.searchParams.get('token')));
      }
      if (url.pathname === '/admin/videos') {
        const cod = String(url.searchParams.get('gerar') || '').replace(/\D/g, '');
        if (cod) {
          const item = catalogo.porCodigo.get(cod);
          if (item) {
            videos.fila.push(item);
            videos.processar();
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(paginaVideos(url.searchParams.get('token')));
      }
      if (url.pathname === '/admin/radar') {
        // Simula uma novidade da carteira para testar o Radar sem esperar o Imoview.
        const cod = String(url.searchParams.get('codigo') || '').replace(/\D/g, '');
        const item = catalogo.porCodigo.get(cod);
        if (!item) return responderJson(res, 404, { erro: 'código não encontrado na carteira' });
        const planejados = planejarRadar({ novos: [item], baixas: [] });
        if (url.searchParams.get('enviar') === '1') await cicloRadar();
        return responderJson(res, 200, { ok: true, clientes_com_perfil_compativel: planejados });
      }
      if (url.pathname === '/admin/resumo') {
        // Prévia do resumo das 8h de cada corretor. Com &enviar=1 envia agora (de verdade).
        const envios = planejarResumos();
        if (url.searchParams.get('enviar') === '1') {
          for (const e of envios) await zapi.enviarTexto(e.fone, e.texto, { delayTyping: 1 }).catch((err) => log('resumo_erro', { erro: err.message }));
        }
        return responderJson(res, 200, { enviado: url.searchParams.get('enviar') === '1', resumos: envios.map((e) => ({ corretor: config.nomesCorretores[digitos(e.fone)] || foneExibicao(e.fone), carteira: e.carteira, texto: e.texto })) });
      }
      if (url.pathname === '/admin/posvisita') {
        // Visitas prontas para o pós-visita. Com &enviar=1 dispara agora (dentro da janela de envio).
        const prontas = rotinas.visitasParaPosVisita({ visitas: store.visitas, conversas: store.conversas, horasDepois: config.posVisita.horasDepois });
        if (url.searchParams.get('enviar') === '1') await cicloPosVisita();
        return responderJson(res, 200, {
          prontas: prontas.map((v) => ({ id: v.id, cliente: v.nome, codigo: v.codigo, data: v.data, hora: v.hora })),
          respondidas: store.visitas.filter((v) => v.posVisita && v.posVisita.respondidaEm).slice(-20).map((v) => ({ codigo: v.codigo, nota: v.posVisita.nota, resposta: v.posVisita.resposta })),
        });
      }
      if (url.pathname === '/admin/leads.csv') {
        const linhas = [['atualizado_em', 'nome', 'telefone', 'temperatura', 'finalidade', 'tipo', 'cidade', 'bairros', 'preco_min', 'preco_max', 'quartos', 'prazo', 'pagamento', 'imovel_interesse', 'observacoes']];
        for (const l of Object.values(store.leads)) {
          const q = l.qualificacao || {};
          linhas.push([l.atualizadoEm, l.nome, l.fone, l.temperatura, q.finalidade, q.tipo, q.cidade, [].concat(q.bairros || []).join(', '), q.preco_min, q.preco_max, q.dormitorios, q.prazo, q.pagamento, q.codigo_imovel_interesse, q.observacoes]);
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads-gabi-mafuz.csv"' });
        return res.end('﻿' + csv(linhas));
      }

      if (url.pathname === '/admin/conversa') {
        const alvo = acharConversa(url.searchParams.get('fone') || '');
        const c = alvo && store.conversas[alvo];
        return responderJson(res, c ? 200 : 404, c || { erro: 'conversa não encontrada' });
      }

      if (url.pathname === '/admin/estado') {
        return responderJson(res, 200, {
          config: {
            assistente: config.agente.nome,
            site: config.site.url,
            modelo: config.llm.provedor === 'openai' ? config.llm.openaiModelo : config.llm.anthropicModelo,
            numeros_gestao: config.equipe.alertas.map((n) => '••' + n.slice(-4)),
            corretores_venda: config.equipe.venda.map((n) => '••' + n.slice(-4)),
            corretores_locacao: config.equipe.locacao.map((n) => '••' + n.slice(-4)),
            silencio_apos_corretor_min: config.comportamento.pausaHumanoMin,
            reengajamento: { ativo: config.reengajamento.ativo, cutucada_min: config.reengajamento.cutucadaMin, followups_dias: config.reengajamento.followupDias, janela: config.reengajamento.janela },
            em_modo_teste: Object.keys(store.global.testers || {}).map((n) => '••' + n.slice(-4)),
          },
          catalogo: catalogo.status(),
          webhooks_recentes: rastro.slice(-40),
          assistente: botAtivo() ? 'ligado' : 'desligado',
          conversas: Object.values(store.conversas)
            .sort((a, b) => b.atualizadaEm - a.atualizadaEm)
            .slice(0, 50)
            .map((c) => ({
              fone: c.fone,
              nome: c.nome,
              atualizada: new Date(c.atualizadaEm).toISOString(),
              mensagens: c.historico.length,
              temperatura: c.temperatura,
              em_silencio: c.pausadoAte > Date.now() ? c.motivoPausa : false,
            })),
          visitas: store.visitas.slice(-30),
          eventos: store.eventos.slice(-100),
        });
      }
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    log('http_erro', { rota: url.pathname, erro: e.message });
    if (!res.headersSent) responderJson(res, 500, { erro: 'erro interno' });
  }
});

function iniciar() {
  const faltando = validar();
  if (faltando.length) log('config_incompleta', { faltando });
  servidor.listen(config.porta, () => {
    log('servidor_no_ar', { porta: config.porta, versao: VERSAO, modo: config.comportamento.modo, llm: config.llm.provedor });
  });
  if (config.imoview.chave) {
    imoview.garantirListas().catch(() => {});
    catalogo.iniciar(config.catalogo.sincronizarACadaMin);
  }
  // Varre as conversas em busca de cutucadas e follow-ups (a cada minuto; mais rápido em teste).
  const tick = config.reengajamento.escala < 1 ? 1000 : 60000;
  setInterval(() => cicloReengajamento().catch(() => {}), tick).unref();
  setInterval(() => cicloRadar().catch(() => {}), tick).unref();
  setInterval(() => cicloResumo().catch(() => {}), 60000).unref();
  setInterval(() => cicloPosVisita().catch(() => {}), 5 * 60000).unref();
  const encerrar = () => {
    store.salvar(true);
    process.exit(0);
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

if (require.main === module) iniciar();

module.exports = { planejarResumos, cicloResumo, cicloPosVisita, registrarRespostaPosVisita, cerebro, instagram, planejarRadar, cicloRadar, enviarRadar, funil, videos, agenda, servidor, processarWebhook, store, agente, imoview, catalogo, filas, iniciar, chaveFone, rastro, cicloReengajamento, tipoReengajamento };
