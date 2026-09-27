'use strict';
// Simulação ponta a ponta SEM tocar no WhatsApp real:
//   - Z-API falsa (captura o que seria enviado)
//   - modelo de linguagem falso (roteiro determinístico, formato OpenAI)
//   - Imoview REAL (somente leitura) se IMOVIEW_API_KEY estiver definida; envio de lead ao CRM desligado.
// Uso: IMOVIEW_API_KEY=... node test/simulate.js

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORTA_ZAPI = 4610;
const PORTA_LLM = 4620;
const PORTA_APP = 4630;
const CLIENTE = '5531988887777';
const CLIENTE2 = '5531977776666';
const CLIENTE3 = '5531966665555';
const EQUIPE = '5531900000001';
const VENDA = '5531900000002';
const LOCACAO = '5531900000003';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafuz-sim-'));
Object.assign(process.env, {
  PORT: String(PORTA_APP),
  ZAPI_BASE_URL: `http://127.0.0.1:${PORTA_ZAPI}`,
  ZAPI_INSTANCE_ID: 'INST',
  ZAPI_TOKEN: 'TOK',
  ZAPI_CLIENT_TOKEN: 'CT',
  OPENAI_BASE_URL: `http://127.0.0.1:${PORTA_LLM}/v1`,
  OPENAI_API_KEY: 'sk-teste',
  LLM_PROVIDER: 'openai',
  WEBHOOK_SECRET: 's3cr3t',
  ADMIN_TOKEN: 'adm',
  TEAM_PHONES: EQUIPE,
  TEAM_VENDA: VENDA,
  TEAM_LOCACAO: LOCACAO,
  DEBOUNCE_VARIACAO_MS: '200',
  REENGAJAMENTO: 'false',
  DEBOUNCE_MS: '400',
  DATA_DIR: dataDir,
  TRANSCREVER_AUDIO: 'false',
  IMOVIEW_ENVIAR_LEADS: 'false',
  SITE_URL: 'https://mafuz.site',
  SITE_SUPABASE_URL: process.env.SITE_SUPABASE_URL || 'https://gdkzyhvqyqucnbwtsryg.supabase.co',
  SITE_SUPABASE_ANON_KEY: process.env.SITE_SUPABASE_ANON_KEY || '',
  MODO_OPERACAO: '24h',
});
if (!process.env.IMOVIEW_API_KEY) {
  console.error('Defina IMOVIEW_API_KEY para a simulação (a busca é real, somente leitura).');
  process.exit(1);
}

// ---------- Z-API falsa ----------
const enviados = [];
const zapi = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const corpo = b ? JSON.parse(b) : {};
    if (req.url.endsWith('/send-text') || req.url.endsWith('/send-image')) {
      if (req.headers['client-token'] !== 'CT') console.log('!! Client-Token ausente');
      const img = req.url.endsWith('/send-image');
      enviados.push({ ...corpo, message: img ? corpo.caption : corpo.message, imagem: img ? String(corpo.image).slice(0, 30) : null, ts: Date.now() });
      res.end(JSON.stringify({ zaapId: 'z' + enviados.length, messageId: 'M' + enviados.length }));
    } else if (req.url.endsWith('/status')) res.end(JSON.stringify({ connected: true }));
    else res.end(JSON.stringify({ value: true }));
  });
});

// ---------- LLM falso ----------
const chamadasLLM = [];
function respostaTexto(t) {
  return { choices: [{ message: { role: 'assistant', content: t } }], usage: {} };
}
function respostaTool(nome, args) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name: nome, arguments: JSON.stringify(args) } }] } }],
  };
}
const llm = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const corpo = JSON.parse(b);
    chamadasLLM.push(corpo);
    const msgs = corpo.messages;
    const sistema = msgs[0].content;
    const ult = msgs[msgs.length - 1];
    let out;
    if (ult.role === 'tool') {
      const anterior = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
      const nome = anterior.tool_calls[0].function.name;
      const dado = JSON.parse(ult.content);
      const site = sistema.includes('CANAL: CHAT DO SITE');
      if (nome === 'buscar_imoveis' && site) {
        const l = (dado.imoveis || []).slice(0, 3).map((i) => `${i.tipo} no ${i.bairro}, ${i.preco_formatado}: ${i.url}`);
        out = respostaTexto(`Separei estas opções:\n\n${l.join('\n')}\n\nQuer que eu refine por algum detalhe?`);
      } else if (nome === 'buscar_imoveis') {
        const l = (dado.imoveis || []).slice(0, 3).map((i) => ({ codigo: i.codigo, motivo: `Tem ${i.dormitorios || 'bons'} quartos na região que você pediu.` }));
        out = respostaTool('enviar_imoveis', { imoveis: l });
      } else if (nome === 'enviar_imoveis') {
        out = respostaTexto(`Perfeito. Separei ${dado.enviados.length} opções que combinam com o que você pediu.\n\nQual delas te chamou mais a atenção?`);
      } else if (nome === 'agendar_visita') {
        out = respostaTexto(dado.erro ? `Esse horário não fecha. ${dado.erro}` : `Reservado: ${dado.quando}, no ${dado.bairro}.\n\nUm corretor da MAFUZ confirma com você por aqui.\n${dado.url}`);
      } else if (nome === 'transferir_humano') {
        out = respostaTexto('Vou te conectar agora com um dos nossos corretores. Já passei todo o nosso histórico — você não vai precisar repetir nada.');
      } else if (nome === 'registrar_lead') {
        out = respostaTexto('Anotado. Seus dados são usados apenas para o seu atendimento, conforme nossa política de privacidade.\n\nQuer que eu busque opções agora?');
      } else out = respostaTexto('ok');
    } else {
      const t = String(ult.content).toLowerCase();
      if (sistema.includes('MODO REENGAJAMENTO (cutucada)')) {
        out = respostaTexto('Fiquei pensando no apartamento que te mostrei. Quer que eu veja se o condomínio tem área de lazer coberta?');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      if (sistema.includes('MODO REENGAJAMENTO (followup7)')) {
        out = respostaTexto('Vou deixar sua busca salva por aqui. Quando fizer sentido, é só me chamar.');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      if (t.includes('falha')) {
        res.statusCode = 500;
        return res.end('{"error":"simulado"}');
      }
      if (t.includes('apartamento')) {
        out = respostaTool('buscar_imoveis', { finalidade: 'venda', cidade: 'Nova Lima', bairros: ['Vila da Serra'], tipo: 'apartamento', dormitorios_min: 4, preco_max: 3000000 });
      } else if (t.includes('quero visitar')) {
        out = respostaTexto('Que ótimo! Vamos marcar.\n\nQual o melhor dia e horário para você?');
      } else if (t.includes('pode ser a primeira') || t.includes('reservar direto')) {
        const cod = (sistema.match(/código (\d+):/) || [])[1];
        const dia = sistema.match(/\[(\d{4}-\d{2}-\d{2})\]: das (\d{2}):\d{2} às/);
        const hora = `${String(Math.min(+dia[2] + 1, 16)).padStart(2, '0')}:00`;
        out = respostaTool('agendar_visita', { codigo_imovel: cod, data: dia[1], hora, nome: 'Carlos Teste' });
      } else if (t.includes('link falso')) {
        out = respostaTexto('Olha este aqui:\nhttps://mafuz.site/imovel/00000000-inventado\n\nE este site externo: https://concorrente.com.br/x');
      } else if (t.includes('desconto')) {
        out = respostaTexto('Entendo, vou verificar isso.');
      } else if (t.includes('corretor')) {
        out = respostaTool('transferir_humano', { motivo: 'pedido_do_cliente', urgencia: 'normal', resumo: 'Cliente pediu corretor.' });
      } else if (t.includes('meu nome')) {
        out = respostaTool('registrar_lead', { nome: 'Carlos Teste', finalidade: 'comprar', cidade: 'Nova Lima', tipo: 'apartamento', preco_max: 3000000, prazo: 'ate_30d', pagamento: 'financiamento' });
      } else {
        out = respostaTexto('Boa tarde! Aqui é a Gabi, da Mafuz Imóveis de Luxo — tudo bem?\n\nVocê procura para comprar ou alugar, e em qual região?');
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

// ---------- utilitários ----------
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function webhook(payload, secret = 's3cr3t') {
  const r = await fetch(`http://127.0.0.1:${PORTA_APP}/webhook/zapi?secret=${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.status;
}
function msgCliente(fone, texto, extra = {}) {
  return {
    type: 'ReceivedCallback',
    phone: fone,
    fromMe: false,
    fromApi: false,
    isGroup: false,
    isNewsletter: false,
    broadcast: false,
    messageId: 'IN' + ++seq,
    momment: Date.now(),
    senderName: 'Carlos',
    text: { message: texto },
    ...extra,
  };
}
async function aguardarEnvios(minimo, timeout = 60000) {
  const t0 = Date.now();
  while (enviados.length < minimo && Date.now() - t0 < timeout) await esperar(150);
  await esperar(600);
}
const resultados = [];
function checar(nome, ok, detalhe = '') {
  resultados.push({ nome, ok });
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
const paraCliente = (fone, desde) => enviados.slice(desde).filter((e) => e.phone === fone);
const paraEquipe = (desde) => enviados.slice(desde).filter((e) => e.phone === EQUIPE);
const paraFone = (fone, desde) => enviados.slice(desde).filter((e) => e.phone === fone);

(async () => {
  await new Promise((r) => zapi.listen(PORTA_ZAPI, r));
  await new Promise((r) => llm.listen(PORTA_LLM, r));
  const app = require('../src/server');
  app.iniciar();
  await esperar(1500);
  for (let i = 0; i < 120 && !app.catalogo.pronto(); i++) await esperar(1000);
  checar('carrega a carteira inteira do Imoview', app.catalogo.itens.length > 2000, `${app.catalogo.itens.length} imóveis`);

  // 0) saúde e segurança do webhook
  const saude = await (await fetch(`http://127.0.0.1:${PORTA_APP}/health`)).json();
  checar('health responde', saude.ok === true && saude.config_faltando.length === 0, JSON.stringify(saude.config_faltando));
  checar('webhook com secret errado é recusado', (await webhook(msgCliente(CLIENTE, 'oi'), 'errado')) === 401);

  // 1) mensagens quebradas viram um único turno + busca real no Imoview
  let marco = enviados.length;
  const antesLLM = chamadasLLM.length;
  await webhook(msgCliente(CLIENTE, 'oi'));
  await esperar(100);
  await webhook(msgCliente(CLIENTE, 'procuro apartamento na vila da serra, 4 quartos, até 3 milhões'));
  await aguardarEnvios(marco + 5, 90000);
  const primeiraChamada = chamadasLLM[antesLLM];
  const userMsg = primeiraChamada.messages[primeiraChamada.messages.length - 1].content;
  checar('agrupa mensagens quebradas num só turno', userMsg.includes('oi') && userMsg.includes('apartamento'), JSON.stringify(userMsg));
  checar('abre com saudação no primeiro contato', primeiraChamada.messages[0].content.includes('PRIMEIRA mensagem'));
  const resp1 = paraCliente(CLIENTE, marco);
  const links = resp1.map((e) => e.message).join('\n').match(/https:\/\/mafuz\.site\/imovel\/\S+/g) || [];
  checar('apresenta imóveis reais com link do site', links.length >= 1 && links.length <= 4, `${links.length} links`);
  const fotos = resp1.filter((e) => e.imagem);
  checar('cada imóvel vai com foto de capa', fotos.length >= 1 && fotos.every((e) => /^data:image\//.test(e.imagem)), `${fotos.length} fotos`);
  const textos = resp1.filter((e) => !e.imagem && !/mafuz\.site\/imovel/.test(e.message));
  checar('no máximo 2 mensagens de texto além dos imóveis', textos.length >= 1 && textos.length <= 2, `${textos.length} textos`);
  checar('pergunta de continuação vem depois dos imóveis', /\?\s*$/.test(resp1[resp1.length - 1].message), resp1[resp1.length - 1].message);
  checar('usa "digitando..." de 2 a 6 s', resp1.every((e) => e.delayTyping >= 2 && e.delayTyping <= 6));
  checar('nenhum link do Imoview', !resp1.some((e) => /imoview/i.test(e.message)));
  console.log('\n--- resposta enviada ao cliente ---\n' + resp1.map((e) => e.message).join('\n~~\n') + '\n-----------------------------------\n');

  // 2) barreira contra link inventado e site externo
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'me manda o link falso'));
  await aguardarEnvios(marco + 1);
  const txt2 = paraCliente(CLIENTE, marco).map((e) => e.message).join('\n');
  checar('bloqueia link de imóvel que não veio da ferramenta', !txt2.includes('inventado'), txt2.replace(/\n/g, ' / '));
  checar('bloqueia link externo', !txt2.includes('concorrente'));

  // 3) qualificação -> lead + alerta para a equipe
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'meu nome é Carlos, quero comprar em até 30 dias, financiado'));
  await aguardarEnvios(marco + 2);
  const alertaLead = paraEquipe(marco).find((e) => e.message.includes('NOVO LEAD'));
  checar('registra lead e alerta a equipe', !!alertaLead, alertaLead ? alertaLead.message.split('\n').slice(0, 4).join(' | ') : '');
  checar('lead classificado como A (até 30 dias)', app.store.leads[CLIENTE] && app.store.leads[CLIENTE].temperatura === 'A');

  // 4) agendamento: primeiro oferece horários, depois reserva
  const CLIENTE7 = '5531922221111';
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE7, 'reservar direto'));
  await aguardarEnvios(marco + 1);
  checar('não reserva sem o cliente escolher horário', !paraEquipe(marco).some((e) => e.message.includes('PEDIDO DE VISITA')));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'quero visitar o primeiro'));
  await aguardarEnvios(marco + 1);
  checar('pergunta o melhor dia e horário antes de reservar', paraCliente(CLIENTE, marco).some((e) => /melhor dia e hor[aá]rio/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'pode ser a primeira data, às 11h'));
  await aguardarEnvios(marco + 3);
  const alertaVisita = paraEquipe(marco).find((e) => e.message.includes('visita solicitada'));
  checar('reserva visita e alerta a gestão', !!alertaVisita, alertaVisita ? alertaVisita.message.split('\n')[0] : JSON.stringify(paraCliente(CLIENTE, marco)));
  checar('alerta de visita vai para os corretores de VENDA', paraFone(VENDA, marco).some((e) => /NOVO LEAD · VENDA/.test(e.message)));
  checar('alerta de venda não vai para a locação', !paraFone(LOCACAO, marco).length);
  const txtVisita = paraCliente(CLIENTE, marco).map((e) => e.message).join('\n');
  checar('confirma ao cliente com link', /Reservado/.test(txtVisita) && /mafuz\.site/.test(txtVisita), txtVisita.replace(/\n/g, ' / '));

  // 5) negociação: transfere mesmo se o modelo não chamar a ferramenta
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'aceita 2 milhões? me dá um desconto'));
  await aguardarEnvios(marco + 2);
  const alertaHumano = paraEquipe(marco).find((e) => e.message.includes('NOVO LEAD ·'));
  checar('negociação dispara chamada ao corretor pelo código', !!alertaHumano && /negocia/.test(alertaHumano.message));
  checar('cliente recebe mensagem de passagem de bastão', paraCliente(CLIENTE, marco).some((e) => /corretor/i.test(e.message)));
  checar('após chamar o corretor, a assistente segue disponível', !app.store.pausado(CLIENTE) && !!app.store.conversas[CLIENTE].encaminhamento);
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'alô?'));
  await aguardarEnvios(marco + 1);
  checar('continua respondendo enquanto o corretor não entra', paraCliente(CLIENTE, marco).length >= 1);
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'me dá um desconto então'));
  await aguardarEnvios(marco + 1);
  checar('não repete o alerta de corretor pelo mesmo motivo', !paraEquipe(marco).some((e) => /NOVO LEAD ·/.test(e.message)));

  // 6) comandos da equipe: pausar e devolver a conversa
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, `#pausar ${CLIENTE}`));
  await aguardarEnvios(marco + 1);
  checar('#pausar silencia o cliente', app.store.pausado(CLIENTE));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'tem alguém aí?'));
  await esperar(1500);
  checar('cliente pausado não recebe resposta', paraCliente(CLIENTE, marco).length === 0);
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, `#retomar ${CLIENTE}`));
  await aguardarEnvios(marco + 1);
  checar('#retomar funciona', !app.store.pausado(CLIENTE) && paraEquipe(marco).some((e) => /volta a responder/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, '#status'));
  await aguardarEnvios(marco + 1);
  checar('#status responde', paraEquipe(marco).some((e) => /Gabi LIGADA/.test(e.message) && /Carteira carregada/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, 'ok, vou ligar pra ele'));
  await esperar(1500);
  checar('mensagem comum da equipe não vira atendimento', enviados.length === marco);

  // 6b) modo teste: número da equipe conversa como cliente
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, '#teste'));
  await aguardarEnvios(marco + 1);
  checar('#teste liga o modo teste', paraEquipe(marco).some((e) => /Modo teste LIGADO/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, 'oi'));
  await aguardarEnvios(marco + 1);
  checar('em modo teste, a equipe conversa com o agente', paraEquipe(marco).some((e) => /Gabi/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, '#reset'));
  await aguardarEnvios(marco + 1);
  checar('#reset apaga a conversa de teste', !app.store.conversas[EQUIPE] && paraEquipe(marco).some((e) => /apagada/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, '#teste off'));
  await aguardarEnvios(marco + 1);
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, 'oi de novo'));
  await esperar(1500);
  checar('#teste off volta a ignorar mensagens da equipe', enviados.length === marco);

  // 7) humano assume pelo celular -> assistente se cala
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE2, 'boa tarde'));
  await aguardarEnvios(marco + 1);
  await webhook({ ...msgCliente(CLIENTE2, 'Oi, aqui é a Marcella, corretora da MAFUZ!'), fromMe: true, fromApi: false });
  await esperar(300);
  checar('humano respondeu pelo celular -> pausa', app.store.pausado(CLIENTE2));
  const falta = app.store.conversas[CLIENTE2].pausadoAte - Date.now();
  checar('silêncio dura 60 min e depois a Gabi volta', falta > 55 * 60000 && falta <= 60 * 60000, `${Math.round(falta / 60000)} min`);
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE2, 'oi Marcella'));
  await esperar(1500);
  checar('assistente não atropela o corretor', paraCliente(CLIENTE2, marco).length === 0);

  // 8) eco das próprias mensagens não pausa
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE3, 'olá'));
  await aguardarEnvios(marco + 1);
  const eco = paraCliente(CLIENTE3, marco)[0];
  await webhook({ ...msgCliente(CLIENTE3, eco.message), fromMe: true, fromApi: false });
  await esperar(300);
  checar('eco da própria resposta não pausa a conversa', !app.store.pausado(CLIENTE3));

  // 9) grupo ignorado
  marco = enviados.length;
  await webhook({ ...msgCliente('120363000000000000', 'oi grupo'), isGroup: true });
  await esperar(1200);
  checar('ignora grupos', enviados.length === marco);

  // 10) mensagem padrão do site com código do imóvel
  const CLIENTE4 = '5531955554444';
  const antes4 = chamadasLLM.length;
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE4, 'Olá MAFUZ! Sou Ana Souza e tenho interesse neste imóvel:\n\n🏡 Casa\n🔖 Código: 17095\n\nGostaria de mais informações e de agendar uma visita.', { senderName: '🌸' }));
  await aguardarEnvios(marco + 1);
  const sis4 = chamadasLLM[antes4].messages[0].content;
  checar('reconhece imóvel de origem vindo do site', /Imóvel de origem \(veio do site\): código 17095/.test(sis4));
  checar('reconhece o nome da mensagem do site', app.store.conversas[CLIENTE4].nome === 'Ana Souza', app.store.conversas[CLIENTE4].nome);

  // 11) áudio sem transcrição
  const CLIENTE5 = '5531944443333';
  const antes5 = chamadasLLM.length;
  marco = enviados.length;
  await webhook({ ...msgCliente(CLIENTE5, ''), text: undefined, audio: { audioUrl: 'http://127.0.0.1:1/a.ogg', mimeType: 'audio/ogg' } });
  await aguardarEnvios(marco + 1);
  const u5 = chamadasLLM[antes5].messages.slice(-1)[0].content;
  checar('áudio chega ao modelo com instrução de pedir texto', /áudio/.test(u5), u5);

  // 12) falha do modelo -> espera, nova tentativa, escala
  const CLIENTE6 = '5531933332222';
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE6, 'FALHA total'));
  await aguardarEnvios(marco + 2, 90000);
  const t6 = paraCliente(CLIENTE6, marco).map((e) => e.message).join(' / ');
  checar('falha do modelo: tenta de novo, avisa com gentileza e alerta a equipe', /minutinho/.test(t6) && paraEquipe(marco).some((e) => /FALHA TÉCNICA/.test(e.message)), t6);
  checar('falha do modelo não cala a conversa', !app.store.pausado(CLIENTE6));

  // 12b) reengajamento: regras e envio
  const agora = Date.now();
  const h = (papel, texto, minAtras) => ({ papel, texto, ts: agora - minAtras * 60000 });
  const base = { fone: '5531911112222', historico: [], visitas: [], reeng: { cutucadaDe: 0, followups: {} } };
  const t = (hist, extra = {}) => app.tipoReengajamento({ ...base, ...extra, reeng: { cutucadaDe: 0, followups: {} }, historico: hist }, agora);
  checar('cutucada após 15 min sem resposta', (t([h('cliente', 'oi', 20), h('agente', 'Você prefere casa ou apartamento?', 16)]) || {}).tipo === 'cutucada');
  checar('sem cutucada antes de 15 min', t([h('cliente', 'oi', 20), h('agente', 'Casa ou apartamento?', 10)]) === null);
  checar('sem cutucada se a Gabi não fez pergunta', t([h('cliente', 'oi', 20), h('agente', 'Combinado, te aviso.', 16)]) === null);
  checar('follow-up de 3 dias', (t([h('cliente', 'oi', 3 * 1440 + 10), h('agente', 'Casa ou apartamento?', 3 * 1440)]) || {}).tipo === 'followup3');
  const conv7 = { ...base, historico: [h('cliente', 'oi', 7 * 1440 + 10), h('agente', 'Casa ou apartamento?', 4 * 1440)], reeng: { cutucadaDe: 1, followups: {} } };
  conv7.reeng.followups[3] = conv7.historico[0].ts;
  checar('follow-up de 7 dias depois do de 3', (app.tipoReengajamento(conv7, agora) || {}).tipo === 'followup7');
  checar('sem follow-up com visita marcada', t([h('cliente', 'oi', 5000), h('agente', 'Casa?', 4500)], { visitas: ['V1'] }) === null);
  checar('sem follow-up se o cliente pediu para parar', t([h('cliente', 'oi', 5000), h('agente', 'Casa?', 4500)], { optOut: true }) === null);
  checar('sem follow-up se um corretor assumiu', t([h('cliente', 'oi', 5000), h('agente', 'Casa?', 4500)], { humanoAssumiuEm: agora - 60000 }) === null);
  marco = enviados.length;
  const re = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/reengajar?token=adm&fone=${CLIENTE3}&tipo=cutucada`)).json();
  await aguardarEnvios(marco + 1);
  checar('reengajamento envia mensagem humana ao cliente', re.ok && paraCliente(CLIENTE3, marco).some((e) => /Fiquei pensando/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE3, 'não tenho mais interesse, obrigado'));
  await aguardarEnvios(marco + 1);
  checar('pedido para parar desliga os follow-ups', app.store.conversas[CLIENTE3].optOut === true);

  // 12c) chat do site com o mesmo cérebro
  const sse = await (
    await fetch(`http://127.0.0.1:${PORTA_APP}/site/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mafuz.site' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'procuro apartamento na vila da serra' }] }),
    })
  ).text();
  checar('chat do site responde em SSE com cartões [ID:]', /data: \{/.test(sse) && /\[ID:[0-9a-f-]{36}\]/.test(sse) && /\[DONE\]/.test(sse), sse.slice(0, 160).replace(/\n/g, ' '));
  const pre = await fetch(`http://127.0.0.1:${PORTA_APP}/site/chat`, { method: 'OPTIONS', headers: { Origin: 'https://mafuz.site' } });
  checar('chat do site libera CORS para mafuz.site', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://mafuz.site');

  // 12d) lead do site chega na hora para a carteira certa
  marco = enviados.length;
  const ld = await fetch(`http://127.0.0.1:${PORTA_APP}/site/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://mafuz.site' },
    body: JSON.stringify({ nome: 'Paula Teste', telefone: '31 99999-0000', finalidade: 'aluguel', origem: 'agendar visita', imovel: 'Cód. 123', data: '30/09 às 10h' }),
  });
  await aguardarEnvios(marco + 2);
  checar('lead do site responde ok', ld.status === 200);
  checar('lead do site alerta gestão e locação', paraFone(EQUIPE, marco).some((e) => /NOVO LEAD · LOCAÇÃO · site/.test(e.message)) && paraFone(LOCACAO, marco).some((e) => /Paula Teste/.test(e.message)) && !paraFone(VENDA, marco).length);
  checar('lead do site sem contato é recusado', (await fetch(`http://127.0.0.1:${PORTA_APP}/site/lead`, { method: 'POST', body: '{"nome":"x"}' })).status === 400);

  // 13) painel
  const csv = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/leads.csv?token=adm`)).text();
  checar('exporta leads em CSV', csv.includes('Carlos'));
  checar('admin sem token é recusado', (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/estado`)).status === 401);
  const wh = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/configurar-webhook?token=adm`)).json();
  checar('configura webhook da Z-API com 1 clique', wh.ok === true && /\/webhook\/zapi\?secret=/.test(wh.webhook), wh.webhook);
  const dg = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/diagnostico?token=adm`)).json();
  checar('diagnóstico das três integrações', !dg.zapi.erro && dg.imoview.ok && dg.llm.ok, JSON.stringify(dg.imoview));

  const antesSim = enviados.length;
  const sim = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/simular?token=adm&conversa=x&texto=${encodeURIComponent('procuro apartamento na vila da serra')}`)).json();
  checar('simulação em produção responde sem enviar WhatsApp', Array.isArray(sim.mensagens) && sim.mensagens.length > 0 && enviados.length === antesSim, (sim.mensagens || []).join(' / ').slice(0, 120));
  checar('simulação mostra os imóveis que iriam com foto', Array.isArray(sim.imoveis_com_foto) && sim.imoveis_com_foto.length >= 1);

  const comTravessao = enviados.filter((e) => ![EQUIPE, VENDA, LOCACAO].includes(e.phone) && /[—–]/.test(e.message || ''));
  checar('nenhuma mensagem ao cliente tem travessão', comTravessao.length === 0, comTravessao.map((e) => e.message).join(' | ').slice(0, 200));
  const est = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/estado?token=adm`)).json();
  checar('painel mostra o rastro dos webhooks', Array.isArray(est.webhooks_recentes) && est.webhooks_recentes.length > 0 && est.catalogo.imoveis > 2000);

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram.`);
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
