'use strict';
// Toda a configuração vem de variáveis de ambiente (painel "Variables" da Railway).
// Nenhuma chave fica no código.

const fs = require('fs');
const path = require('path');

// Carrega um arquivo .env local, se existir (útil para rodar no computador).
(function carregarDotEnv() {
  const arquivo = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = (k, padrao = '') => {
  const v = process.env[k];
  return v === undefined || v === '' ? padrao : v;
};
const lista = (v) => String(v || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const bool = (v) => ['1', 'true', 'sim', 'yes', 'on'].includes(String(v).toLowerCase());

// HORARIO_COMERCIAL: dias da semana (0=domingo) e faixas. Ex.: "1-5 09:00-18:00; 6 09:00-13:00"
function parseHorario(texto) {
  const regras = {};
  for (const bloco of String(texto).split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = bloco.match(/^(\d)(?:-(\d))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const ini = +m[1];
    const fim = m[2] !== undefined ? +m[2] : ini;
    for (let d = ini; d <= fim; d++) {
      regras[d] = { abre: +m[3] * 60 + +m[4], fecha: +m[5] * 60 + +m[6] };
    }
  }
  return regras;
}

const config = {
  porta: +env('PORT', '3000'),
  webhookSecret: env('WEBHOOK_SECRET'),
  adminToken: env('ADMIN_TOKEN'),

  zapi: {
    baseUrl: env('ZAPI_BASE_URL', 'https://api.z-api.io').replace(/\/$/, ''),
    instancia: env('ZAPI_INSTANCE_ID'),
    token: env('ZAPI_TOKEN'),
    clientToken: env('ZAPI_CLIENT_TOKEN'),
  },

  imoview: {
    baseUrl: env('IMOVIEW_BASE_URL', 'https://api.imoview.com.br').replace(/\/$/, ''),
    chave: env('IMOVIEW_API_KEY'),
    enviarLeads: bool(env('IMOVIEW_ENVIAR_LEADS', 'false')),
    midiaLead: env('IMOVIEW_MIDIA_LEAD', 'WhatsApp - Gabi'),
    codigoUnidadeLead: env('IMOVIEW_CODIGO_UNIDADE'),
    emailCorretorLead: env('IMOVIEW_EMAIL_CORRETOR'),
  },

  site: {
    url: env('SITE_URL', 'https://mafuz.site').replace(/\/$/, ''),
    // Origens autorizadas a usar a Gabi pelo chat do site (/site/chat).
    origensChat: String(env('SITE_CHAT_ORIGINS', 'https://mafuz.site,https://www.mafuz.site,http://localhost:8080,null')).split(',').map((s) => s.trim()).filter(Boolean),
    // Chave pública ("anon", somente leitura) que o próprio site usa no navegador — não é segredo.
    supabaseUrl: env('SITE_SUPABASE_URL', 'https://gdkzyhvqyqucnbwtsryg.supabase.co').replace(/\/$/, ''),
    supabaseAnonKey: env(
      'SITE_SUPABASE_ANON_KEY',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdka3p5aHZxeXF1Y25id3RzcnlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTQ2MDIsImV4cCI6MjA5NDE5MDYwMn0.RzOavqQyG_oKKZHDX7VovXMxkPNuyNEjkB_5dAVpTQg'
    ),
  },

  llm: {
    provedor: env('LLM_PROVIDER', 'openai').toLowerCase(),
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    anthropicBaseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/$/, ''),
    openaiKey: env('OPENAI_API_KEY'),
    openaiModelo: env('OPENAI_MODEL', 'gpt-5.4-mini'),
    openaiEsforco: env('OPENAI_REASONING_EFFORT', ''), // gpt-5.4-mini não aceita reasoning_effort junto com ferramentas no Chat Completions
    anthropicKey: env('ANTHROPIC_API_KEY'),
    anthropicModelo: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    maxTokens: +env('LLM_MAX_TOKENS', '900'),
    timeoutMs: +env('LLM_TIMEOUT_MS', '45000'),
  },

  agente: {
    // Como a assistente se apresenta ao cliente.
    nome: env('AGENTE_NOME', 'Gabi'),
    empresa: env('EMPRESA_NOME', 'Mafuz Imóveis de Luxo'),
  },

  catalogo: {
    // A base inteira do Imoview é recarregada a cada N minutos (mínimo 5).
    sincronizarACadaMin: +env('CATALOGO_SYNC_MIN', '15'),
  },

  // Radar MAFUZ: avisa o cliente quando entra (ou baixa de preço) um imóvel com o perfil que ele pediu.
  radar: {
    ativo: bool(env('RADAR', 'true')),
    // No máximo um aviso por cliente a cada N horas, com até N imóveis.
    intervaloHoras: +env('RADAR_INTERVALO_HORAS', '20'),
    maxImoveis: +env('RADAR_MAX_IMOVEIS', '2'),
    // Perfil vale por N dias depois da última conversa.
    validadeDias: +env('RADAR_VALIDADE_DIAS', '60'),
  },

  // Google Agenda dos corretores (horários livres reais e evento da visita).
  // GOOGLE_SERVICE_ACCOUNT_JSON: JSON da conta de serviço (texto puro ou base64).
  // AGENDA_CORRETORES: telefone=email da agenda, separados por vírgula.
  //   Ex.: 5531989097232=marcella@mafuz.com.br,5531988093993=thais@mafuz.com.br
  // Cada corretor compartilha a própria agenda com o e-mail da conta de serviço
  // ("Fazer alterações nos eventos").
  agenda: {
    contaServico: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
    corretores: String(env('AGENDA_CORRETORES', ''))
      .split(',')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2 && p[0].replace(/\D/g, '') && p[1].includes('@'))
      .map(([fone, email]) => ({ fone: fone.replace(/\D/g, ''), email: email.trim() })),
    duracaoMin: +env('VISITA_DURACAO_MIN', '60'),
    diasAFrente: +env('AGENDA_DIAS', '7'),
    criarEvento: bool(env('AGENDA_CRIAR_EVENTO', 'true')),
  },

  // Vídeo vertical (1080x1920, 15 s) gerado automaticamente para cada imóvel novo.
  video: {
    ativo: bool(env('VIDEO_AUTOMATICO', 'true')),
    // Endereço público deste servidor (para a Z-API buscar o vídeo). Ex.: https://mafuz-agente-production.up.railway.app
    urlPublica: env('PUBLIC_URL', env('RAILWAY_PUBLIC_DOMAIN') ? `https://${env('RAILWAY_PUBLIC_DOMAIN')}` : '').replace(/\/$/, ''),
    enviarNoWhatsApp: bool(env('VIDEO_NO_WHATSAPP', 'true')),
    ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
    // Na primeira carga não gera vídeo da carteira inteira: só dos imóveis que entrarem depois.
    maxPorCiclo: +env('VIDEO_MAX_POR_CICLO', '6'),
  },

  // Parâmetros de campanha nos links que a Gabi envia (medição no GA4 e no Meta).
  utm: {
    ativo: bool(env('UTM_LINKS', 'true')),
    source: env('UTM_SOURCE', 'whatsapp'),
    medium: env('UTM_MEDIUM', 'gabi'),
  },

  equipe: {
    // Gestão: recebem TODOS os alertas (lead novo, visita, corretor, falha). Formato 5531999999999, separados por vírgula.
    alertas: lista(env('TEAM_PHONES')),
    // Corretores por carteira: recebem os pedidos de corretor e de visita da carteira deles.
    venda: lista(env('TEAM_VENDA', '5531989097232,5531988093993')),
    locacao: lista(env('TEAM_LOCACAO', '5531987176953,5531994099755,5531999549025')),
    // Podem mandar comandos (#status, #pausar, #retomar, #desligar, #ligar) para o número da MAFUZ.
    admins: lista(env('ADMIN_PHONES')),
    // Nome exibido ao cliente quando ele é transferido (ex.: "nossa equipe de corretores").
    nomeTransferencia: env('NOME_EQUIPE', 'um dos nossos corretores'),
  },

  comportamento: {
    botAtivo: bool(env('BOT_ATIVO', 'true')),
    // "24h" = responde sempre | "fora_do_horario" = só fora do horário comercial (Fase 1 do plano)
    modo: env('MODO_OPERACAO', '24h'),
    horarioTexto: env('HORARIO_COMERCIAL', '1-5 09:00-18:00; 6 09:00-13:00'),
    horarioVisitasTexto: env('HORARIO_VISITAS', '1-5 09:00-18:00; 6 09:00-13:00'),
    // Espera o cliente terminar de digitar: base + variação aleatória (padrão 4 a 7 s).
    debounceMs: +env('DEBOUNCE_MS', '4000'),
    debounceVariacaoMs: +env('DEBOUNCE_VARIACAO_MS', '3000'),
    // Quando um corretor responde pelo número da MAFUZ, a Gabi fica em silêncio e volta
    // sozinha depois deste tempo sem nova mensagem do corretor.
    pausaHumanoMin: +env('PAUSA_HUMANO_MIN', '60'),
    // Máximo de mensagens de texto por resposta (os cartões de imóvel são à parte).
    maxMensagens: +env('MAX_MENSAGENS', '2'),
    enviarFotos: bool(env('ENVIAR_FOTOS', 'true')),
    maxTurnosSemAvanco: +env('MAX_TURNOS', '12'),
    conversaTtlDias: +env('CONVERSA_TTL_DIAS', '15'),
    transcreverAudio: bool(env('TRANSCREVER_AUDIO', 'true')),
    modeloTranscricao: env('MODELO_TRANSCRICAO', 'whisper-1'),
    limiteAltoTicket: +env('LIMITE_ALTO_TICKET', '10000000'),
  },

  // Reengajamento: cutucada após N minutos sem resposta e follow-ups em dias.
  reengajamento: {
    ativo: bool(env('REENGAJAMENTO', 'true')),
    cutucadaMin: +env('CUTUCADA_MIN', '15'),
    followupDias: String(env('FOLLOWUP_DIAS', '3,7')).split(',').map(Number).filter((n) => n > 0),
    // Janela de envio: nada sai fora dela (fica para o próximo horário válido). Padrão: seg a sáb, 8h às 21h.
    janela: env('JANELA_ENVIO', '1-6 08:00-21:00'),
    // Só para testes: multiplica os tempos (ex.: 0.001 simula dias em segundos).
    escala: +env('REENGAJAMENTO_ESCALA', '1'),
  },

  // Resumo das 8h no WhatsApp de cada corretor (visitas do dia, clientes esperando, novos na carteira).
  resumo: {
    ativo: bool(env('RESUMO_8H', 'true')),
    hora: +env('RESUMO_HORA', '8'),
    // Dias da semana (0 = domingo). Padrão: segunda a sábado.
    dias: String(env('RESUMO_DIAS', '1,2,3,4,5,6')).split(',').map(Number).filter((n) => n >= 0 && n <= 6),
  },

  // Pós-visita: mensagem ao cliente N horas depois de uma visita confirmada pela equipe.
  posVisita: {
    ativo: bool(env('POS_VISITA', 'true')),
    horasDepois: +env('POS_VISITA_HORAS', '2'),
  },

  // Nomes dos corretores (telefone=nome) para o resumo das 8h.
  nomesCorretores: Object.fromEntries(
    String(env('NOMES_CORRETORES', '5531989097232=Marcella,5531988093993=Thais,5531987176953=Raina,5531994099755=Ana Flavia,5531999549025=Catia'))
      .split(',')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2)
      .map(([f, n]) => [f.replace(/\D/g, ''), n.trim()])
  ),

  // Instagram da MAFUZ no site (token de longa duração da API do Instagram).
  instagram: {
    token: env('INSTAGRAM_TOKEN'),
    perfil: env('INSTAGRAM_PERFIL', 'mafuzimoveisdeluxo'),
  },

  dataDir: env('DATA_DIR', path.join(__dirname, '..', 'data')),
  timezone: 'America/Sao_Paulo',
};

config.comportamento.horario = parseHorario(config.comportamento.horarioTexto);
config.comportamento.horarioVisitas = parseHorario(config.comportamento.horarioVisitasTexto);
config.reengajamento.janelaRegras = parseHorario(config.reengajamento.janela);

function validar() {
  const faltando = [];
  if (!config.zapi.instancia) faltando.push('ZAPI_INSTANCE_ID');
  if (!config.zapi.token) faltando.push('ZAPI_TOKEN');
  if (!config.imoview.chave) faltando.push('IMOVIEW_API_KEY');
  if (config.llm.provedor === 'openai' && !config.llm.openaiKey) faltando.push('OPENAI_API_KEY');
  if (config.llm.provedor === 'anthropic' && !config.llm.anthropicKey) faltando.push('ANTHROPIC_API_KEY');
  if (!config.webhookSecret) faltando.push('WEBHOOK_SECRET');
  return faltando;
}

module.exports = { config, validar, parseHorario };
