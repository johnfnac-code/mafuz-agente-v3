'use strict';
// O cérebro da conversa: monta o contexto, conversa com o modelo, executa as
// ferramentas contra o Imoview e aplica as barreiras de saída (guardrails em código).

const { montarSistema } = require('./prompt');
const {
  log,
  formatarBRL,
  foneExibicao,
  proximosDiasVisita,
  validarHorarioVisita,
  rotuloData,
} = require('./util');

const FERRAMENTAS = [
  {
    name: 'buscar_imoveis',
    description:
      'Busca na carteira INTEIRA da Mafuz (todos os imóveis do Imoview, à venda e para alugar), lendo inclusive a descrição de cada anúncio. Use sempre que o cliente disser o que procura ou pedir outro recorte. Coloque os desejos do cliente em texto_livre. Retorna até 6 imóveis com resumo, o que atende ao pedido, destaques, oportunidade e link. Depois, apresente até 4 com enviar_imoveis.',
    parameters: {
      type: 'object',
      properties: {
        finalidade: { type: 'string', enum: ['venda', 'locacao'], description: 'venda (comprar ou investir) ou locacao (alugar)' },
        cidade: { type: 'string', description: 'Cidade, só quando o cliente disser. Ex.: Nova Lima, Belo Horizonte, Lagoa Santa. Na dúvida, deixe vazio e use bairros.' },
        bairros: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Lugares do jeito que o cliente falou: bairros, condomínios ou regiões. Ex.: ["Vila da Serra"], ["Alphaville"], ["Gran Royalle"], ["Seis Pistas"], ["Zona Sul"], ["Pampulha"], ["Lagoa dos Ingleses"], ["Vetor Norte"]. A busca reconhece todos os bairros e condomínios da carteira, mesmo com erro de digitação.',
        },
        tipo: { type: 'string', description: 'apartamento | casa | cobertura | lote | comercial | rural' },
        preco_min: { type: 'number', description: 'Valor mínimo em reais (número inteiro)' },
        preco_max: { type: 'number', description: 'Valor máximo em reais (número inteiro), ex.: 3000000' },
        dormitorios_min: { type: 'integer' },
        suites_min: { type: 'integer' },
        vagas_min: { type: 'integer' },
        area_min: { type: 'number', description: 'Área mínima em m²' },
        texto_livre: { type: 'string', description: 'Desejos qualitativos: "piscina", "vista para a serra", "aceita pet", "varanda gourmet"' },
        codigo: { type: 'string', description: 'Código do imóvel, quando o cliente citar um código' },
        ordenar: { type: 'string', enum: ['relevancia', 'menor_preco', 'maior_preco', 'maior_area'], description: 'Padrão: relevância para o pedido e melhores oportunidades' },
        limite: { type: 'integer', description: 'Máximo de resultados (até 6)' },
      },
    },
  },
  {
    name: 'enviar_imoveis',
    description:
      'Envia ao cliente até 4 imóveis, cada um em uma mensagem separada com a foto de capa, os dados principais e o link do site. Use depois de buscar_imoveis ou detalhar_imovel. Na sua resposta final não repita os imóveis: escreva só uma introdução curta e a pergunta de continuação.',
    parameters: {
      type: 'object',
      properties: {
        imoveis: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              codigo: { type: 'string', description: 'Código do imóvel (vem de buscar_imoveis)' },
              motivo: { type: 'string', description: 'Uma frase curta: por que este imóvel combina com este cliente. Só com dados da busca.' },
            },
            required: ['codigo', 'motivo'],
          },
        },
      },
      required: ['imoveis'],
    },
  },
  {
    name: 'mercado_regiao',
    description:
      'Retrato de preços de uma região a partir da carteira ativa da Mafuz: quantidade de imóveis, preço mediano, faixa de preço, valor mediano por m² (quando a amostra permite), novidades dos últimos 30 dias e imóveis com preço reduzido. Use para perguntas de mercado, preço do m² ou movimento de um bairro. Não é índice oficial.',
    parameters: {
      type: 'object',
      properties: {
        bairro: { type: 'string', description: 'Bairro ou condomínio, ex.: Vila da Serra, Alphaville, Belvedere' },
        cidade: { type: 'string', description: 'Cidade, ex.: Nova Lima, Belo Horizonte, Lagoa Santa' },
        tipo: { type: 'string', description: 'apartamento | casa | cobertura | lote | comercial' },
        finalidade: { type: 'string', enum: ['venda', 'locacao'] },
      },
    },
  },
  {
    name: 'detalhar_imovel',
    description:
      'Traz a ficha completa de um imóvel pelo código: descrição, diferenciais, condomínio, IPTU, áreas, se aceita financiamento/permuta/pets e link. Use para qualquer pergunta sobre um imóvel específico.',
    parameters: {
      type: 'object',
      properties: { codigo: { type: 'string', description: 'Código do imóvel (vem de buscar_imoveis)' } },
      required: ['codigo'],
    },
  },
  {
    name: 'registrar_lead',
    description:
      'Cria ou atualiza o lead do cliente para a equipe comercial. Chame assim que tiver 4 campos de qualificação, e de novo quando surgirem campos novos relevantes.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        email: { type: 'string' },
        finalidade: { type: 'string', enum: ['comprar', 'alugar', 'investir'] },
        cidade: { type: 'string' },
        bairros: { type: 'array', items: { type: 'string' } },
        tipo: { type: 'string' },
        preco_min: { type: 'number' },
        preco_max: { type: 'number' },
        dormitorios: { type: 'integer' },
        suites: { type: 'integer' },
        vagas: { type: 'integer' },
        prazo: { type: 'string', enum: ['ate_30d', '30_90d', 'acima_90d'] },
        pagamento: { type: 'string', enum: ['a_vista', 'financiamento', 'permuta', 'avaliando'] },
        codigo_imovel_interesse: { type: 'string' },
        observacoes: { type: 'string', description: 'Resumo curto do que o cliente procura, nas palavras dele' },
      },
    },
  },
  {
    name: 'agendar_visita',
    description:
      'Reserva a visita a um imóvel no dia e horário aceitos pelo cliente e avisa a equipe, que confirma com o cliente. Use só depois que o cliente escolher um horário.',
    parameters: {
      type: 'object',
      properties: {
        codigo_imovel: { type: 'string' },
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:mm' },
        nome: { type: 'string', description: 'Nome do cliente' },
        observacoes: { type: 'string' },
      },
      required: ['codigo_imovel', 'data', 'hora', 'nome'],
    },
  },
  {
    name: 'horarios_livres',
    description:
      'Consulta a agenda real dos corretores (Google Agenda) e devolve até 3 horários livres para a visita. Use depois que o cliente disser o dia ou o período que prefere (ou pedir sugestão). Ofereça exatamente os rótulos devolvidos e reserve com agendar_visita usando data e hora de um deles.',
    parameters: {
      type: 'object',
      properties: {
        codigo_imovel: { type: 'string', description: 'Imóvel da visita' },
        data_preferida: { type: 'string', description: 'AAAA-MM-DD, se o cliente disse um dia' },
        periodo: { type: 'string', enum: ['manha', 'tarde', 'qualquer'] },
      },
    },
  },
  {
    name: 'transferir_humano',
    description:
      'Avisa os corretores da carteira certa (venda ou locação) para assumirem a conversa, com resumo. A Gabi continua atendendo até um corretor escrever. Use nos gatilhos de transferência.',
    parameters: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          enum: [
            'qualificado',
            'pedido_do_cliente',
            'negociacao',
            'juridico',
            'reclamacao',
            'alto_ticket',
            'parceiro',
            'venda_do_imovel',
            'lgpd',
            'sem_progresso',
            'busca_dedicada',
            'falha_tecnica',
            'outro',
          ],
        },
        urgencia: { type: 'string', enum: ['normal', 'alta'] },
        resumo: { type: 'string', description: 'Resumo em 3 linhas curtas: quem é, o que procura, o que pediu' },
      },
      required: ['motivo', 'resumo'],
    },
  },
];

const RE_NEGOCIACAO =
  /\b(desconto|contra-?proposta|proposta|negoci\w*|abaix\w+ (o )?(valor|pre[cç]o)|fech[ao]\w* por|aceita\w* \d|pago \d|pagar \d|ofere[cç]o \d|oferta de \d|melhor pre[cç]o|valor final)\b/i;

const MOTIVO_LEGIVEL = {
  qualificado: 'lead qualificado, visita reservada',
  pedido_do_cliente: 'cliente pediu atendimento humano',
  negociacao: 'negociação de valor',
  juridico: 'assunto jurídico/documentação',
  reclamacao: 'reclamação',
  alto_ticket: 'imóvel acima de R$ 10 mi',
  parceiro: 'corretor/parceiro/incorporadora',
  venda_do_imovel: 'quer vender/anunciar imóvel',
  lgpd: 'pedido LGPD (exclusão de dados)',
  sem_progresso: 'conversa sem avanço',
  busca_dedicada: 'busca dedicada 24h',
  falha_tecnica: 'falha técnica do assistente',
  outro: 'outro',
};

const ORDEM_TEMP = { C: 1, B: 2, A: 3 };

const { registrarPerfil } = require('./radar');

/** Acrescenta os parâmetros de campanha (GA4/Meta) ao link do site. */
function comUtm(url, campanha, config) {
  if (!url || !config || !config.utm || !config.utm.ativo) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      u.searchParams.set('utm_source', config.utm.source);
      u.searchParams.set('utm_medium', config.utm.medium);
      u.searchParams.set('utm_campaign', campanha || 'atendimento');
    }
    return u.toString();
  } catch {
    return url;
  }
}

class Agente {
  constructor({ config, store, zapi, imoview, llm, catalogo, agenda }) {
    this.config = config;
    this.catalogo = catalogo || null;
    this.agenda = agenda || null;
    this.store = store;
    this.zapi = zapi;
    this.imoview = imoview;
    this.llm = llm;
    this.enviadosRecentes = new Map(); // fone -> [{texto, ts}]
  }

  detectarNegociacao(texto) {
    return RE_NEGOCIACAO.test(texto || '');
  }

  // ---------------- alertas para a equipe ----------------
  // Carteira da conversa: locação quando o cliente quer alugar ou o imóvel é de locação; senão, venda.
  carteiraDe(conv, ficha) {
    const f = String((ficha && ficha.finalidade) || '').toLowerCase();
    if (/loca|alug/.test(f)) return 'locacao';
    if (f) return 'venda';
    const q = (conv && conv.qualificacao) || {};
    if (q.finalidade === 'alugar') return 'locacao';
    const i = q.codigo_imovel_interesse && conv.imoveis && conv.imoveis[q.codigo_imovel_interesse];
    if (i && i.finalidade === 'locacao') return 'locacao';
    return 'venda';
  }

  destinatarios(carteira) {
    const eq = this.config.equipe;
    const lista = [...eq.alertas, ...(carteira === 'locacao' ? eq.locacao : carteira === 'venda' ? eq.venda : [])];
    return [...new Set(lista)];
  }

  async alertarEquipe(texto, carteira = null) {
    const dest = this.destinatarios(carteira);
    for (const fone of dest) {
      try {
        this.marcarEnviado(fone, texto);
        await this.zapi.enviarTexto(fone, texto);
      } catch (e) {
        log('alerta_erro', { erro: e.message });
      }
    }
    if (!dest.length) log('alerta_sem_destino', { texto: texto.slice(0, 200) });
  }

  // Alertas saem DEPOIS da resposta ao cliente (e com os imóveis já marcados como apresentados).
  // Sem turno (ex.: falha técnica), sai na hora.
  async alertar(turno, montarTexto, carteira = null) {
    if (turno && Array.isArray(turno.alertas)) turno.alertas.push({ montar: montarTexto, carteira });
    else await this.alertarEquipe(montarTexto(), carteira);
  }

  marcarEnviado(fone, texto) {
    const lista = this.enviadosRecentes.get(fone) || [];
    const agora = Date.now();
    lista.push({ texto: String(texto).trim(), ts: agora });
    this.enviadosRecentes.set(fone, lista.filter((x) => agora - x.ts < 180000));
  }

  foiEnviadoPorNos(fone, texto) {
    const lista = this.enviadosRecentes.get(fone) || [];
    const t = String(texto || '').trim();
    return !!t && lista.some((x) => x.texto === t && Date.now() - x.ts < 180000);
  }

  resumoBusca(q) {
    const partes = [];
    if (q.finalidade) partes.push(q.finalidade);
    if (q.tipo) partes.push(q.tipo);
    if (q.cidade || (q.bairros && q.bairros.length)) partes.push([q.cidade, q.bairros && q.bairros.length ? `(${[].concat(q.bairros).join(', ')})` : ''].filter(Boolean).join(' '));
    if (q.preco_min || q.preco_max) partes.push(`${q.preco_min ? 'de ' + formatarBRL(q.preco_min) + ' ' : ''}${q.preco_max ? 'até ' + formatarBRL(q.preco_max) : ''}`.trim());
    if (q.dormitorios || q.dormitorios_min) partes.push(`${q.dormitorios || q.dormitorios_min}+ quartos`);
    if (q.suites || q.suites_min) partes.push(`${q.suites || q.suites_min}+ suítes`);
    if (q.vagas || q.vagas_min) partes.push(`${q.vagas || q.vagas_min}+ vagas`);
    return partes.join(' · ') || 'ainda não definida';
  }

  cabecalhoCliente(conv) {
    return `Cliente: ${conv.nome || 'sem nome'} · ${foneExibicao(conv.fone)}\nhttps://wa.me/${conv.fone}`;
  }

  imoveisVistos(conv) {
    const l = Object.values(conv.imoveis).filter((i) => i.apresentado);
    return l.length ? l.map((i) => `${i.codigo} (${i.tipo}, ${i.bairro}, ${i.preco_formatado})`).join('; ') : 'nenhum';
  }

  async enviarLeadImoview(conv, anotacoesExtras = '') {
    if (!this.config.imoview.enviarLeads || conv.leadEnviadoImoview) return;
    const q = conv.qualificacao;
    const anotacoes = [
      `Lead qualificado pela ${this.config.agente.nome} (WhatsApp).`,
      `Busca: ${this.resumoBusca(q)}`,
      q.prazo ? `Prazo: ${q.prazo}` : '',
      q.pagamento ? `Pagamento: ${q.pagamento}` : '',
      conv.temperatura ? `Temperatura: ${conv.temperatura}` : '',
      `Imóveis apresentados: ${this.imoveisVistos(conv)}`,
      q.observacoes ? `Obs.: ${q.observacoes}` : '',
      anotacoesExtras,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const r = await this.imoview.incluirLead({
        nome: conv.nome,
        telefone: conv.fone,
        email: q.email,
        finalidade: q.finalidade === 'alugar' ? 'locacao' : 'venda',
        codigoImovel: q.codigo_imovel_interesse || (conv.origem && conv.origem.codigo),
        anotacoes,
      });
      conv.leadEnviadoImoview = true;
      this.store.evento('lead_imoview', { fone: conv.fone, retorno: JSON.stringify(r).slice(0, 300) });
      log('lead_imoview_ok', { retorno: JSON.stringify(r).slice(0, 200) });
    } catch (e) {
      this.store.evento('lead_imoview_erro', { fone: conv.fone, erro: e.message });
      log('lead_imoview_erro', { erro: e.message });
    }
  }

  registrarImoveis(conv, lista) {
    for (const i of lista) {
      if (!i || !i.codigo) continue;
      conv.imoveis[i.codigo] = {
        ...(conv.imoveis[i.codigo] || {}),
        codigo: i.codigo,
        tipo: i.tipo,
        bairro: i.bairro,
        cidade: i.cidade,
        preco: i.preco,
        preco_formatado: i.preco_formatado,
        url: i.url,
        finalidade: i.finalidade ? (/loca|alug/i.test(i.finalidade) ? 'locacao' : 'venda') : (conv.imoveis[i.codigo] || {}).finalidade,
        dormitorios: i.dormitorios,
        suites: i.suites,
        vagas: i.vagas,
        area_m2: i.area_m2,
        area_lote_m2: i.area_lote_m2,
        condominio: i.condominio,
        unidade: i.unidade_responsavel || (conv.imoveis[i.codigo] || {}).unidade,
      };
      if (i.url && !conv.urlsPermitidas.includes(i.url)) conv.urlsPermitidas.push(i.url);
    }
    const chaves = Object.keys(conv.imoveis);
    if (chaves.length > 40) for (const k of chaves.slice(0, chaves.length - 40)) delete conv.imoveis[k];
    if (conv.urlsPermitidas.length > 80) conv.urlsPermitidas.splice(0, conv.urlsPermitidas.length - 80);
  }

  // ---------------- ferramentas ----------------
  async executar(nome, args, conv, turno) {
    args = args || {};
    switch (nome) {
      case 'buscar_imoveis': {
        const r = this.catalogo && this.catalogo.pronto() ? await this.catalogo.buscar(args) : await this.imoview.buscar(args);
        this.registrarImoveis(conv, r.imoveis);
        const q = conv.qualificacao;
        if (args.finalidade) q.finalidade = q.finalidade || (args.finalidade === 'locacao' ? 'alugar' : 'comprar');
        if (args.cidade) q.cidade = args.cidade;
        if (args.bairros && args.bairros.length) q.bairros = args.bairros;
        if (args.tipo) q.tipo = args.tipo;
        if (args.preco_min) q.preco_min = args.preco_min;
        if (args.preco_max) q.preco_max = args.preco_max;
        if (args.dormitorios_min) q.dormitorios = args.dormitorios_min;
        if (args.suites_min) q.suites = args.suites_min;
        if (args.vagas_min) q.vagas = args.vagas_min;
        turno.buscou = true;
        if (registrarPerfil(conv, args)) conv.radar.campanha = 'radar';
        this.store.evento('busca', { fone: conv.fone, filtros: args, total: r.total_encontrado, codigos: r.imoveis.map((i) => i.codigo) });
        return r;
      }

      case 'enviar_imoveis': {
        const pedidos = Array.isArray(args.imoveis) ? args.imoveis.slice(0, 4) : [];
        const cartoes = [];
        const recusados = [];
        for (const p of pedidos) {
          const cod = String((p && p.codigo) || '').trim();
          const i = conv.imoveis[cod];
          if (!i || !i.url) {
            recusados.push(cod);
            continue;
          }
          if (turno.cartoes.some((c) => c.codigo === cod) || cartoes.some((c) => c.codigo === cod)) continue;
          cartoes.push({ codigo: cod, url: i.url, legenda: this.legendaImovel(i, p.motivo, turno.campanha) });
          i.apresentado = true;
        }
        turno.cartoes.push(...cartoes.slice(0, Math.max(0, 4 - turno.cartoes.length)));
        return {
          enviados: cartoes.map((c) => c.codigo),
          ...(recusados.length ? { recusados, aviso: 'Estes códigos não vieram de uma busca desta conversa e não foram enviados.' } : {}),
          orientacao:
            'Os imóveis vão em mensagens separadas, com foto e link. Na resposta final escreva só: 1) uma introdução curta e 2) a pergunta de continuação. Não repita imóveis nem links.',
        };
      }

      case 'mercado_regiao': {
        if (!this.catalogo || !this.catalogo.pronto()) return { erro: 'Carteira ainda carregando. Diga que o corretor traz o estudo da região.' };
        return this.catalogo.mercadoRegiao(args);
      }

      case 'detalhar_imovel': {
        const ficha = await this.imoview.detalhar(args.codigo);
        if (!ficha) return { erro: 'Este imóvel não está disponível/publicado no momento. Não o cite; ofereça alternativas.' };
        this.registrarImoveis(conv, [ficha]);
        const { codigo_unidade, ...publica } = ficha;
        return publica;
      }

      case 'registrar_lead': {
        const q = conv.qualificacao;
        for (const k of ['email', 'finalidade', 'cidade', 'bairros', 'tipo', 'preco_min', 'preco_max', 'dormitorios', 'suites', 'vagas', 'prazo', 'pagamento', 'codigo_imovel_interesse', 'observacoes']) {
          if (args[k] !== undefined && args[k] !== null && args[k] !== '') q[k] = args[k];
        }
        if (args.nome) conv.nome = String(args.nome).slice(0, 80);
        const temp = { ate_30d: 'A', '30_90d': 'B', acima_90d: 'C' }[q.prazo] || conv.temperatura || null;
        const anterior = this.store.leads[conv.fone];
        const tempAnterior = conv.temperatura;
        conv.temperatura = temp;
        const lead = {
          ...(anterior || { criadoEm: new Date().toISOString(), origem: conv.origem ? 'site' : 'whatsapp' }),
          fone: conv.fone,
          nome: conv.nome,
          temperatura: temp,
          qualificacao: { ...q },
          imovel_origem: conv.origem ? conv.origem.codigo : null,
          imoveis_apresentados: Object.values(conv.imoveis).filter((i) => i.apresentado).map((i) => i.codigo),
          atualizadoEm: new Date().toISOString(),
        };
        this.store.leads[conv.fone] = lead;
        this.store.tocar();
        conv.turnosSemAvanco = 0;
        turno.registrou = true;

        const subiu = temp && (!tempAnterior || ORDEM_TEMP[temp] > ORDEM_TEMP[tempAnterior]);
        if (!anterior || subiu) {
          const titulo = !anterior ? `🟢 NOVO LEAD (${this.config.agente.nome})` : `🔥 LEAD ESQUENTOU (${tempAnterior || '-'} → ${temp})`;
          const interesse = q.codigo_imovel_interesse && conv.imoveis[q.codigo_imovel_interesse];
          await this.alertar(turno, () =>
            [
              titulo,
              this.cabecalhoCliente(conv),
              `Busca: ${this.resumoBusca(q)}`,
              `Prazo: ${q.prazo || 'não informado'}${temp ? ` (lead ${temp})` : ''} · Pagamento: ${q.pagamento || 'não informado'}`,
              interesse ? `Interesse: ${interesse.tipo} · ${interesse.bairro} · ${interesse.preco_formatado}\n${interesse.url}` : '',
              conv.origem ? `Veio do site pelo imóvel ${conv.origem.codigo}` : '',
              `Imóveis apresentados: ${this.imoveisVistos(conv)}`,
              q.observacoes ? `Obs.: ${q.observacoes}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          );
        }
        if (!turno.simulacao) await this.enviarLeadImoview(conv);
        this.store.evento('lead', { fone: conv.fone, temperatura: temp });
        return { lead_id: `WA-${conv.fone.slice(-6)}`, etapa: 'qualificacao', temperatura: temp || 'indefinida' };
      }

      case 'horarios_livres': {
        if (!this.agenda || !this.agenda.ativa()) {
          return { erro: 'Agenda dos corretores não conectada. Pergunte "Qual o melhor dia e horário para você?" e siga com agendar_visita.' };
        }
        const i = args.codigo_imovel && conv.imoveis[args.codigo_imovel];
        const carteira = this.carteiraDe(conv, i || null);
        try {
          const opcoes = await this.agenda.horariosLivres({ carteira, data: args.data_preferida, periodo: args.periodo });
          if (!opcoes.length) return { disponivel: false, orientacao: 'Não há horário livre nos próximos dias. Pergunte outra data ou chame transferir_humano.' };
          conv.horariosOferecidos = opcoes.map((o) => ({ data: o.data, hora: o.hora }));
          return {
            disponivel: true,
            opcoes: opcoes.map((o) => ({ rotulo: o.rotulo, data: o.data, hora: o.hora })),
            orientacao: 'Ofereça estes horários (no máximo 3, com o rótulo exato) e pergunte qual fica melhor. Não invente outros.',
          };
        } catch (e) {
          return { erro: `Agenda indisponível agora (${e.message}). Pergunte o melhor dia e horário e siga com agendar_visita.` };
        }
      }

      case 'agendar_visita': {
        const regras = this.config.comportamento.horarioVisitas;
        const ficha = await this.imoview.detalhar(args.codigo_imovel);
        if (!ficha) return { erro: 'Imóvel não está mais disponível. Não reserve; avise o cliente e ofereça alternativas.' };
        this.registrarImoveis(conv, [ficha]);
        if (args.nome) conv.nome = String(args.nome).slice(0, 80);

        // Mesma visita já reservada: só reconfirma (sem novo alerta).
        const jaExiste = this.store.visitas.find((v) => v.fone === conv.fone && v.codigo === ficha.codigo && v.data === args.data && v.hora === args.hora);
        if (jaExiste) {
          return {
            agendamento_id: jaExiste.id,
            status: 'ja_reservado_aguardando_confirmacao',
            quando: `${rotuloData(args.data)} às ${args.hora}`,
            bairro: ficha.bairro,
            condominio: ficha.condominio,
            url: ficha.url,
            proximo_passo: 'Esta visita já estava reservada. Apenas reconfirme ao cliente em uma linha, sem repetir tudo.',
          };
        }

        // Barreira: só reserva se (a) a última mensagem do assistente foi uma oferta de horários
        // (e não a lista de imóveis) ou (b) o próprio cliente disse um horário agora.
        const reHora = /\b\d{1,2}\s?(?:h\b|h\d{2}|:\d{2})/gi;
        const ultAgente = [...conv.historico].reverse().find((h) => h.papel === 'agente');
        const ofereceu =
          (!!ultAgente && (ultAgente.texto.match(reHora) || []).length >= 2 && !/\/imovel\/|\/imoveis\?q=/.test(ultAgente.texto)) ||
          (conv.horariosOferecidos || []).some((h) => h.data === args.data && h.hora === args.hora);
        const clienteDisse = (String(turno.textoCliente || '').match(reHora) || []).length >= 1;
        if (!ofereceu && !clienteDisse) {
          return {
            erro: 'O cliente ainda não disse dia e horário. NÃO reserve agora: pergunte "Qual o melhor dia e horário para você?" (se ele pedir sugestão, ofereça duas opções das janelas abaixo) e espere a resposta.',
            janelas: proximosDiasVisita(regras, 4).map((d) => `${d.rotulo} [${d.data}] ${d.janela}`),
          };
        }
        const erroHorario = validarHorarioVisita(regras, args.data, args.hora);
        if (erroHorario) {
          return {
            erro: `Horário inválido: ${erroHorario}. Ofereça duas opções dentro das janelas abaixo.`,
            janelas: proximosDiasVisita(regras, 4).map((d) => `${d.rotulo} [${d.data}] ${d.janela}`),
          };
        }
        // Agenda real: confirma que segue livre e cria o evento na agenda do corretor.
        let reserva = null;
        if (this.agenda && this.agenda.ativa() && !turno.simulacao) {
          try {
            reserva = await this.agenda.reservar({
              carteira: this.carteiraDe(conv, ficha),
              data: args.data,
              hora: args.hora,
              titulo: `Visita MAFUZ · ${conv.nome || 'cliente'} · ${ficha.bairro}`,
              descricao: [`Cliente: ${conv.nome || ''} · https://wa.me/${conv.fone}`, `Imóvel ${ficha.codigo}: ${ficha.tipo} · ${ficha.bairro}`, ficha.url, args.observacoes ? `Obs.: ${args.observacoes}` : '', 'Agendada pela Gabi.'].filter(Boolean).join('\n'),
            });
            if (reserva && !reserva.ok) {
              const opcoes = await this.agenda.horariosLivres({ carteira: this.carteiraDe(conv, ficha), data: args.data }).catch(() => []);
              conv.horariosOferecidos = opcoes.map((o) => ({ data: o.data, hora: o.hora }));
              return { erro: 'Esse horário acabou de ser ocupado na agenda dos corretores. Ofereça estas opções.', opcoes: opcoes.map((o) => o.rotulo) };
            }
          } catch (e) {
            reserva = null; // agenda fora do ar: segue o fluxo normal, a equipe confirma
          }
        }
        const visita = {
          id: 'V' + Date.now().toString(36).toUpperCase(),
          fone: conv.fone,
          nome: conv.nome,
          codigo: ficha.codigo,
          url: ficha.url,
          bairro: ficha.bairro,
          data: args.data,
          hora: args.hora,
          observacoes: args.observacoes || '',
          status: 'aguardando_confirmacao',
          criadaEm: new Date().toISOString(),
        };
        this.store.visitas.push(visita);
        conv.visitas.push(visita.id);
        conv.qualificacao.codigo_imovel_interesse = ficha.codigo;
        conv.turnosSemAvanco = 0;
        turno.agendou = true;
        const carteiraVisita = this.carteiraDe(conv, ficha);
        await this.alertar(
          turno,
          () =>
            [
              `🔔 NOVO LEAD · ${carteiraVisita === 'locacao' ? 'LOCAÇÃO' : 'VENDA'} · visita solicitada`,
              this.cabecalhoCliente(conv),
              `Busca: ${this.resumoBusca(conv.qualificacao)}`,
              `Imóvel de interesse: ${ficha.codigo} · ${ficha.tipo} · ${ficha.bairro}${ficha.condominio ? ` (${ficha.condominio})` : ''} · ${ficha.preco_formatado}`,
              ficha.url,
              `Visita: ${rotuloData(args.data)} às ${args.hora}`,
              reserva && reserva.corretor ? `Na agenda de: ${reserva.corretor.email}${reserva.evento ? ' ✅' : ''}` : '',
              visita.observacoes ? `Obs.: ${visita.observacoes}` : '',
              `Confirme com o cliente pelo WhatsApp da Mafuz. Quando você escrever, a ${this.config.agente.nome} fica em silêncio por ${this.config.comportamento.pausaHumanoMin} min.`,
            ]
              .filter(Boolean)
              .join('\n'),
          carteiraVisita
        );
        if (!turno.simulacao) await this.enviarLeadImoview(conv, `Visita solicitada: ${rotuloData(args.data)} às ${args.hora}, imóvel ${ficha.codigo}`);
        this.store.evento('visita', { fone: conv.fone, id: visita.id, codigo: ficha.codigo, data: args.data, hora: args.hora });
        return {
          agendamento_id: visita.id,
          status: 'reservado_aguardando_confirmacao',
          quando: `${rotuloData(args.data)} às ${args.hora}`,
          bairro: ficha.bairro,
          condominio: ficha.condominio,
          url: ficha.url,
          proximo_passo: 'Um corretor da MAFUZ confirma a visita com o cliente por este WhatsApp e informa o endereço.',
        };
      }

      case 'transferir_humano': {
        const motivo = args.motivo || 'outro';
        const urgencia = args.urgencia || (['negociacao', 'alto_ticket', 'reclamacao', 'lgpd'].includes(motivo) ? 'alta' : 'normal');
        const minutosPausa = this.config.comportamento.pausaHumanoMin;
        const anterior = conv.encaminhamento;
        const repetido = anterior && anterior.motivo === motivo && Date.now() - anterior.ts < 60 * 60000;
        conv.encaminhamento = { motivo, urgencia, ts: repetido ? anterior.ts : Date.now() };
        conv.transferencias.push({ motivo, urgencia, resumo: args.resumo, ts: Date.now() });
        conv.turnosSemAvanco = 0;
        turno.transferiu = true;
        // Visita reservada já gerou o alerta completo; o "qualificado" logo depois não repete.
        const jaAlertouVisita = motivo === 'qualificado' && turno.agendou;
        if (!repetido && !jaAlertouVisita) {
          const carteiraT = this.carteiraDe(conv);
          const interesse = conv.qualificacao.codigo_imovel_interesse && conv.imoveis[conv.qualificacao.codigo_imovel_interesse];
          await this.alertar(
            turno,
            () =>
              [
                `🔔 NOVO LEAD · ${carteiraT === 'locacao' ? 'LOCAÇÃO' : 'VENDA'} · ${MOTIVO_LEGIVEL[motivo] || motivo}${urgencia === 'alta' ? ' · URGENTE' : ''}`,
                this.cabecalhoCliente(conv),
                `Busca: ${this.resumoBusca(conv.qualificacao)}`,
                interesse ? `Imóvel de interesse: ${interesse.codigo} · ${interesse.tipo} · ${interesse.bairro} · ${interesse.preco_formatado}\n${interesse.url}` : `Imóveis enviados: ${this.imoveisVistos(conv)}`,
                `Resumo:\n${args.resumo || '-'}`,
                `A ${this.config.agente.nome} segue atendendo até alguém responder este cliente pelo WhatsApp da Mafuz. Quando você responder, ela fica em silêncio por ${minutosPausa} min.`,
              ].join('\n'),
            carteiraT
          );
          if (motivo !== 'lgpd' && !turno.simulacao) await this.enviarLeadImoview(conv, `Encaminhado ao corretor: ${MOTIVO_LEGIVEL[motivo] || motivo}. ${args.resumo || ''}`);
        }
        this.store.evento('transferencia', { fone: conv.fone, motivo, urgencia, repetido: !!repetido });
        return {
          encaminhado: true,
          ja_tinha_sido_avisado: !!repetido,
          orientacao: 'O corretor foi avisado e vai falar com o cliente por este WhatsApp. Continue atendendo com gentileza até ele entrar na conversa.',
        };
      }

      default:
        return { erro: `Ferramenta desconhecida: ${nome}` };
    }
  }

  // Legenda do cartão de imóvel (vai junto com a foto). Sem travessões.
  legendaImovel(i, motivo, campanha = 'atendimento') {
    const local = [i.bairro, i.cidade].filter(Boolean).join(', ');
    const lote = /lote|terreno/i.test(i.tipo || '');
    const medidas = [
      !lote && i.dormitorios ? `${i.dormitorios} ${i.dormitorios === 1 ? 'quarto' : 'quartos'}` : '',
      !lote && i.suites ? `${i.suites} ${i.suites === 1 ? 'suíte' : 'suítes'}` : '',
      i.area_m2 ? `${Math.round(i.area_m2).toLocaleString('pt-BR')} m²` : i.area_lote_m2 ? `lote de ${Math.round(i.area_lote_m2).toLocaleString('pt-BR')} m²` : '',
      !lote && i.vagas ? `${i.vagas} ${i.vagas === 1 ? 'vaga' : 'vagas'}` : '',
    ].filter(Boolean);
    const preco = i.preco_formatado && !/sob consulta/i.test(i.preco_formatado) ? i.preco_formatado : 'Valor sob consulta';
    const limpo = (t) => String(t || '').replace(/\s*[—–]\s*/g, ', ').replace(/ +- +/g, ', ').trim();
    return [
      `*${limpo(i.tipo)}${local ? ` · ${limpo(local)}` : ''}*`,
      medidas.join(' · '),
      preco + (i.finalidade === 'locacao' && !/sob consulta/i.test(preco) ? ' por mês' : ''),
      motivo ? `\n${limpo(motivo)}` : '',
      `\n${campanha ? comUtm(i.url, campanha, this.config) : i.url}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------------- barreiras de saída ----------------
  guardar(texto, conv) {
    let t = String(texto || '').replace(/\r/g, '');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    t = t.replace(/^#{1,6}\s*/gm, '');
    t = t.replace(/^\s*[-•—–]\s+/gm, '');
    // Sem travessões na conversa (regra da Mafuz): vira vírgula, e faixas numéricas viram "a".
    t = t.replace(/(\d)\s*[—–]\s*(\d)/g, '$1 a $2');
    t = t.replace(/\s*[—–]\s*/g, ', ');
    t = t.replace(/ +- +/g, ', ');
    t = t.replace(/,\s*,/g, ',').replace(/,\s*([.!?:])/g, '$1').replace(/^\s*,\s*/gm, '').replace(/\(\s*,\s*/g, '(');
    t = t.replace(/[ \t]+$/gm, '');

    const permitidas = new Set(conv.urlsPermitidas);
    let hostSite = '';
    try {
      hostSite = new URL(this.config.site.url).host.replace(/^www\./, '');
    } catch {}
    let links = 0;
    const linhas = [];
    for (const linha of t.split('\n')) {
      const urls = linha.match(/https?:\/\/[^\s]+/g) || [];
      let ok = true;
      for (const bruto of urls) {
        const u = bruto.replace(/[.,;:!?)]+$/, '');
        if (/\/imovel\/|\/imoveis\?q=/.test(u)) {
          if (!permitidas.has(u)) {
            ok = false;
            log('guard_link_bloqueado', { url: u });
          } else if (++links > 3) ok = false;
        } else if (!(hostSite && u.includes(hostSite)) && !/wa\.me\//.test(u)) {
          ok = false;
          log('guard_link_externo_bloqueado', { url: u });
        }
      }
      if (ok) linhas.push(linha);
    }
    t = linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    for (const u of permitidas) {
      if (t.includes(u)) for (const i of Object.values(conv.imoveis)) if (i.url === u) i.apresentado = true;
    }
    if (/pol[ií]tica de privacidade/i.test(t)) conv.lgpdAvisado = true;
    return t;
  }

  // ---------------- turno completo ----------------
  async responder(conv, textoCliente, sinais = {}, opcoes = {}) {
    const canal = opcoes.canal || 'whatsapp';
    const totalCarteira = this.catalogo && this.catalogo.pronto() ? this.catalogo.itens.length : 0;
    const sistema = montarSistema({ conv, config: this.config, sinais, totalCarteira, canal });
    const historico = (opcoes.historico || conv.historico.slice(-24).map((h) => ({ role: h.papel === 'cliente' ? 'user' : 'assistant', content: h.papel === 'equipe' ? `[mensagem enviada por ${h.autor || 'um corretor da Mafuz'}] ${h.texto}` : h.texto }))).slice();
    while (historico.length && historico[0].role !== 'user') historico.shift();
    const mensagens = [...historico, { role: 'user', content: textoCliente }];
    const turno = { buscou: false, registrou: false, agendou: false, transferiu: false, ferramentas: [], alertas: [], cartoes: [], textoCliente, simulacao: !!sinais.simulacao };
    turno.campanha = opcoes.canal === 'site' ? null : sinais.reengajamento ? 'reengajamento' : 'atendimento';
    const permitidas = opcoes.ferramentas || null;
    const ferramentas = permitidas ? FERRAMENTAS.filter((f) => permitidas.includes(f.name)) : FERRAMENTAS;

    let final = '';
    for (let passo = 0; passo < 6; passo++) {
      const r = await this.llm.conversar({ sistema, mensagens, ferramentas });
      if (r.toolCalls && r.toolCalls.length) {
        mensagens.push({ role: 'assistant', content: r.texto, toolCalls: r.toolCalls });
        for (const tc of r.toolCalls) {
          let saida;
          try {
            if (permitidas && !permitidas.includes(tc.name)) throw new Error('ferramenta indisponível neste canal');
            saida = await this.executar(tc.name, tc.args, conv, turno);
          } catch (e) {
            log('ferramenta_erro', { ferramenta: tc.name, erro: e.message });
            saida = { erro: 'Sistema de consulta indisponível no momento. Não improvise dados: diga que vai confirmar com o corretor e chame transferir_humano (motivo falha_tecnica).' };
          }
          turno.ferramentas.push(tc.name);
          log('ferramenta', { fone: conv.fone.slice(-4), nome: tc.name, args: tc.args, erro: saida && saida.erro });
          mensagens.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(saida) });
        }
        continue;
      }
      final = r.texto;
      break;
    }

    // Barreira: negociação detectada e o modelo não transferiu -> transfere pelo código.
    if (sinais.negociacao && !turno.transferiu) {
      await this.executar('transferir_humano', { motivo: 'negociacao', urgencia: 'alta', resumo: `Cliente escreveu: "${textoCliente.slice(0, 300)}"` }, conv, turno);
      if (!/conect|corretor|equipe/i.test(final)) {
        final = `${final ? final + '\n\n' : ''}Condições de valor quem conduz é a nossa equipe diretamente. Já chamei ${this.config.equipe.nomeTransferencia}, que vai falar com você por aqui.`;
      }
    }

    if (!final && turno.cartoes.length) final = 'Qual deles te chamou mais a atenção?';
    if (!final && sinais.reengajamento) return { texto: '', turno };
    if (!final) final = 'Me dá só um instante, vou confirmar essa informação e já te retorno por aqui.';
    if ((turno.registrou || turno.agendou) && !conv.lgpdAvisado && !/pol[ií]tica de privacidade/i.test(final)) {
      final += '\n\nSeus dados são usados apenas para o seu atendimento, conforme nossa política de privacidade.';
    }
    return { texto: this.guardar(final, conv), turno };
  }

  // Mensagem proativa (cutucada de 15 min e follow-ups de 3 e 7 dias).
  async reengajar(conv, tipo) {
    const instrucao = `[Sistema: o cliente não respondeu. Escreva agora a mensagem de reengajamento "${tipo}" seguindo as regras de ATENÇÃO. Não mencione este aviso.]`;
    const ferramentas = tipo === 'followup3' ? ['buscar_imoveis', 'enviar_imoveis', 'mercado_regiao'] : [];
    return this.responder(conv, instrucao, { reengajamento: tipo }, { ferramentas });
  }

  // Chat do site (/site/chat): mesmo cérebro, sem ações de WhatsApp. Devolve texto com [ID:uuid]
  // no lugar dos links de imóvel, que o site transforma em cartões com foto.
  async responderSite(mensagensSite) {
    const hist = (Array.isArray(mensagensSite) ? mensagensSite : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-16)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    const ultima = hist.pop();
    if (!ultima || ultima.role !== 'user') return { texto: 'Oi! Sou a Gabi, da Mafuz. Me conta o que você procura?' };
    const conv = { fone: 'site', nome: '', historico: [], qualificacao: {}, imoveis: {}, urlsPermitidas: [], visitas: [], transferencias: [], lgpdAvisado: true };
    const r = await this.responder(conv, ultima.content, {}, { canal: 'site', historico: hist, ferramentas: ['buscar_imoveis', 'detalhar_imovel', 'mercado_regiao'] });
    const texto = r.texto.replace(/https?:\/\/[^\s]*\/imovel\/([0-9a-f-]{36})/gi, '[ID:$1]');
    return { texto, ferramentas: r.turno.ferramentas };
  }
}

module.exports = { Agente, FERRAMENTAS, RE_NEGOCIACAO, comUtm };
