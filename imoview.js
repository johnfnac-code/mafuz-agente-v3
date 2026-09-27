'use strict';
// Cliente do Imoview (CRM da MAFUZ) — fonte da verdade do estoque.
// Endpoints validados com a chave da MAFUZ:
//   POST /Imovel/RetornarImoveisDisponiveis   (filtros no corpo JSON, máx. 20 por página)
//   GET  /Imovel/RetornarDetalhesImovelDisponivel?codigoImovel=
//   GET  /Imovel/RetornarCidadesDisponiveis | RetornarBairrosDisponiveis | RetornarListaTiposImoveis
//   POST /Lead/IncluirLead
// Autenticação: header "chave".
//
// REGRA DE PRIVACIDADE: só campos da lista branca abaixo saem deste módulo.
// Anotações internas, proprietários, comissão e endereço NUNCA chegam ao modelo.

const { log, sleep, norm, parseValorBR, parseNumBR, formatarBRL, limparTitulo, foneNacional } = require('./util');

const TTL_LISTAS = 6 * 3600000;

const GRUPOS_TIPO = {
  apartamento: ['apartamento', 'apartamento duplex', 'area privativa', 'flat', 'studio', 'loft'],
  casa: ['casa', 'casa em condominio'],
  cobertura: ['cobertura'],
  lote: ['lote', 'lote em condominio', 'terreno'],
  comercial: ['loja', 'sala', 'predio', 'andar corporativo', 'andar corrido'],
  rural: ['chacara', 'fazenda', 'haras', 'rancho', 'sitio'],
};

const ALIAS_CIDADE = { bh: 'belo horizonte', 'b h': 'belo horizonte', 'beaga': 'belo horizonte' };

const DIFERENCIAIS = {
  piscina: 'piscina',
  espacogourmet: 'espaço gourmet',
  varandagourmet: 'varanda gourmet',
  churrasqueira: 'churrasqueira',
  academia: 'academia',
  salaofestas: 'salão de festas',
  salaojogos: 'salão de jogos',
  sauna: 'sauna',
  quadratenis: 'quadra de tênis',
  quadraesportiva: 'quadra poliesportiva',
  beachtenis: 'quadra de beach tennis',
  quadrasquash: 'quadra de squash',
  playground: 'playground',
  homecinema: 'home cinema',
  hidromassagem: 'hidromassagem',
  lareira: 'lareira',
  closet: 'closet',
  dce: 'dependência de serviço',
  escritorio: 'escritório',
  lavabo: 'lavabo',
  despensa: 'despensa',
  rouparia: 'rouparia',
  jardim: 'jardim',
  gramado: 'gramado',
  quintal: 'quintal',
  portaria24horas: 'portaria 24h',
  seguranca24horas: 'segurança 24h',
  vistamontanha: 'vista para a montanha',
  vistalago: 'vista para lago/lagoa',
  vistamar: 'vista para o mar',
  solmanha: 'sol da manhã',
  aquecedorsolar: 'aquecimento solar',
  arcondicionado: 'ar-condicionado',
  armariocozinha: 'armários na cozinha',
  armarioquarto: 'armários nos quartos',
  mobiliado: 'mobiliado',
  permiteanimais: 'aceita pets',
};

// Palavras do cliente -> campos booleanos do Imoview (para o filtro "texto_livre").
const PALAVRAS_FLAG = [
  [/piscin/, ['piscina']],
  [/gourmet|churrasq/, ['espacogourmet', 'varandagourmet', 'churrasqueira']],
  [/academ|fitness/, ['academia']],
  [/vista|montanha|serra/, ['vistamontanha', 'vistalago', 'vistamar']],
  [/lago|lagoa/, ['vistalago']],
  [/pet|cachorr|gato|animal/, ['permiteanimais']],
  [/mobiliad/, ['mobiliado']],
  [/lareir/, ['lareira']],
  [/closet/, ['closet']],
  [/escritori|home office/, ['escritorio']],
  [/sauna/, ['sauna']],
  [/tenis|beach/, ['quadratenis', 'beachtenis']],
  [/portaria|seguranc/, ['portaria24horas', 'seguranca24horas']],
  [/jardim|quintal|gramad|verde/, ['jardim', 'quintal', 'gramado']],
  [/solar|sol da manha/, ['solmanha', 'aquecedorsolar']],
];

// Remove contatos, links e travessões da descrição do anúncio antes de ela chegar ao modelo.
function limparDescricao(texto) {
  return String(texto || '')
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const STOP = new Set(['condominio', 'residencial', 'bairro', 'jardim', 'vila', 'do', 'da', 'de', 'dos', 'das', 'e']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));

function casaNome(consulta, candidato) {
  const q = norm(consulta);
  const c = norm(candidato);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (q.length >= 4 && (c.includes(q) || q.includes(c))) return 0.9;
  const tq = tokens(q);
  const tc = tokens(c);
  if (tq.length && tc.length) {
    const inter = tq.filter((t) => tc.some((u) => u === t || (t.length >= 5 && levenshtein(t, u) <= 1))).length;
    const score = inter / tq.length;
    if (score >= 0.99) return 0.85;
    if (score >= 0.5 && inter >= 1 && tq.length >= 2) return 0.6;
  }
  const dist = levenshtein(q, c);
  const ratio = 1 - dist / Math.max(q.length, c.length);
  return ratio >= 0.84 ? ratio * 0.9 : 0;
}

class Imoview {
  constructor(cfg, siteLinks, limiteAltoTicket = 10000000) {
    this.cfg = cfg;
    this.site = siteLinks;
    this.limiteAltoTicket = limiteAltoTicket;
    this.listas = null;
    this.listasTs = 0;
    this.carregando = null;
  }

  async req(metodo, caminho, { query, corpo, tentativas = 2 } = {}) {
    const url = new URL(this.cfg.baseUrl + caminho);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    let ultimo;
    for (let i = 0; i < tentativas; i++) {
      try {
        const r = await fetch(url, {
          method: metodo,
          headers: { chave: this.cfg.chave, accept: 'application/json', 'Content-Type': 'application/json' },
          body: corpo ? JSON.stringify(corpo) : undefined,
          signal: AbortSignal.timeout(20000),
        });
        const texto = await r.text();
        let json;
        try {
          json = JSON.parse(texto);
        } catch {
          json = { bruto: texto.slice(0, 500) };
        }
        if (r.ok) return json;
        ultimo = new Error(`Imoview ${caminho} HTTP ${r.status}: ${texto.slice(0, 200)}`);
        if (r.status < 500 && r.status !== 429) break;
        if (r.status === 429) await sleep(2500 * (i + 1));
      } catch (e) {
        ultimo = e;
      }
      await sleep(600 * (i + 1));
    }
    throw ultimo;
  }

  // ---------- listas de referência (cidades, bairros, tipos) ----------
  async garantirListas() {
    if (this.listas && Date.now() - this.listasTs < TTL_LISTAS) return this.listas;
    if (this.carregando) return this.carregando;
    this.carregando = (async () => {
      try {
        const [cv, cl, bv, bl, tipos] = await Promise.all([
          this.req('GET', '/Imovel/RetornarCidadesDisponiveis', { query: { parametros: { finalidade: 2 } } }),
          this.req('GET', '/Imovel/RetornarCidadesDisponiveis', { query: { parametros: { finalidade: 1 } } }),
          this.req('GET', '/Imovel/RetornarBairrosDisponiveis', { query: { parametros: { finalidade: 2 } } }),
          this.req('GET', '/Imovel/RetornarBairrosDisponiveis', { query: { parametros: { finalidade: 1 } } }),
          this.req('GET', '/Imovel/RetornarListaTiposImoveis'),
        ]);
        const porCodigo = (arr) => {
          const m = new Map();
          for (const x of arr || []) m.set(x.codigo, x);
          return [...m.values()];
        };
        this.listas = {
          cidades: porCodigo([...(cv.lista || []), ...(cl.lista || [])]).map((c) => ({ codigo: c.codigo, nome: String(c.nome).trim(), estado: c.estado })),
          bairros: porCodigo([...(bv.lista || []), ...(bl.lista || [])]).map((b) => ({
            codigo: b.codigo,
            nome: String(b.nome).replace(/\s+/g, ' ').trim(),
            cidade: String(b.cidade || '').trim(),
            cidadeCodigo: b.cidadecodigo,
          })),
          tipos: (tipos.lista || []).map((t) => ({ codigo: t.codigo, nome: String(t.nome).trim() })),
        };
        this.listasTs = Date.now();
        log('imoview_listas', { cidades: this.listas.cidades.length, bairros: this.listas.bairros.length, tipos: this.listas.tipos.length });
      } catch (e) {
        log('imoview_listas_erro', { erro: e.message });
        if (!this.listas) this.listas = { cidades: [], bairros: [], tipos: [] };
      } finally {
        this.carregando = null;
      }
      return this.listas;
    })();
    return this.carregando;
  }

  resolverCidade(nome) {
    if (!nome) return null;
    const q = ALIAS_CIDADE[norm(nome)] || nome;
    let melhor = null;
    for (const c of this.listas.cidades) {
      const s = casaNome(q, c.nome);
      if (s > 0.8 && (!melhor || s > melhor.s)) melhor = { ...c, s };
    }
    return melhor;
  }

  resolverBairros(nomes, codigoCidade) {
    const encontrados = [];
    const naoEncontrados = [];
    for (const nome of nomes || []) {
      const candidatos = this.listas.bairros
        .filter((b) => !codigoCidade || b.cidadeCodigo === codigoCidade)
        .map((b) => ({ ...b, s: casaNome(nome, b.nome) }))
        .filter((b) => b.s >= 0.6)
        .sort((a, b) => b.s - a.s);
      if (!candidatos.length) {
        naoEncontrados.push(nome);
        continue;
      }
      const topo = candidatos[0].s;
      for (const c of candidatos.filter((x) => x.s >= topo - 0.05).slice(0, 4)) {
        if (!encontrados.some((e) => e.codigo === c.codigo)) encontrados.push(c);
      }
    }
    return { encontrados, naoEncontrados };
  }

  resolverTipos(tipo) {
    if (!tipo) return [];
    const q = norm(tipo);
    const grupo = GRUPOS_TIPO[q] || Object.entries(GRUPOS_TIPO).find(([g]) => q.startsWith(g))?.[1];
    const nomes = grupo || [q];
    return this.listas.tipos.filter((t) => nomes.includes(norm(t.nome))).map((t) => t.codigo);
  }

  // ---------- normalização ----------
  resumo(i) {
    const preco = parseValorBR(i.valor);
    return {
      codigo: String(i.codigo),
      tipo: String(i.tipo || '').trim(),
      finalidade: i.finalidade,
      bairro: String(i.bairro || '').replace(/\s+/g, ' ').trim(),
      cidade: String(i.cidade || '').trim().replace(/^Nova lima$/i, 'Nova Lima'),
      condominio: String(i.nomecondominio || '').trim() || undefined,
      preco,
      preco_formatado: formatarBRL(preco),
      dormitorios: parseNumBR(i.numeroquartos) || 0,
      suites: parseNumBR(i.numerosuites) || 0,
      banheiros: parseNumBR(i.numerobanhos) || 0,
      vagas: parseNumBR(i.numerovagas) || 0,
      area_m2: parseNumBR(i.areaprincipal) || null,
      area_lote_m2: parseNumBR(i.arealote) || null,
      alto_ticket: !!preco && preco > this.limiteAltoTicket,
    };
  }

  static grupoTipo(tipo) {
    const t = norm(tipo);
    for (const [g, nomes] of Object.entries(GRUPOS_TIPO)) if (nomes.includes(t)) return g;
    return t;
  }

  // Mesma casa cadastrada duas vezes (ex.: "Casa" e "Casa em condomínio") gera a mesma assinatura.
  static assinatura(r) {
    return [Imoview.grupoTipo(r.tipo), norm(r.bairro), r.preco, Math.round(r.area_m2 || 0), r.dormitorios, r.suites].join('|');
  }

  montarCorpo(f, cidade, bairros) {
    const corpo = { finalidade: f.finalidade === 'locacao' ? 1 : 2, numeroPagina: 1, numeroRegistros: 20 };
    if (cidade) corpo.codigocidade = cidade.codigo;
    if (bairros && bairros.length) corpo.codigosbairros = bairros.map((b) => b.codigo).join(',');
    if (f.tipo) {
      const cod = this.resolverTipos(f.tipo);
      if (cod.length) corpo.codigotipo = cod.join(',');
    }
    if (f.preco_min) corpo.valorde = Math.round(f.preco_min);
    if (f.preco_max) corpo.valorate = Math.round(f.preco_max);
    if (f.dormitorios_min) corpo.numeroquartos = f.dormitorios_min;
    if (f.suites_min) corpo.numerosuite = f.suites_min;
    if (f.vagas_min) corpo.numerovagas = f.vagas_min;
    if (f.area_min) corpo.areade = Math.round(f.area_min);
    if (f.codigo) corpo.codigosimoveis = String(f.codigo).replace(/\D/g, '');
    return corpo;
  }

  // ---------- busca ----------
  async buscar(f = {}) {
    await this.garantirListas();
    const avisos = [];
    const aplicados = { finalidade: f.finalidade === 'locacao' ? 'locação' : 'venda' };

    let cidade = null;
    if (f.cidade) {
      cidade = this.resolverCidade(f.cidade);
      if (!cidade) {
        avisos.push(`A cidade "${f.cidade}" não tem imóveis publicados na carteira.`);
        return { total_encontrado: 0, imoveis: [], filtros_aplicados: aplicados, avisos };
      }
      aplicados.cidade = cidade.nome;
    }

    let bairros = [];
    if (Array.isArray(f.bairros) && f.bairros.length) {
      const r = this.resolverBairros(f.bairros, cidade && cidade.codigo);
      bairros = r.encontrados;
      if (bairros.length) aplicados.bairros = bairros.map((b) => `${b.nome} (${b.cidade})`);
      if (r.naoEncontrados.length) avisos.push(`Sem imóveis publicados no(s) bairro(s): ${r.naoEncontrados.join(', ')}.`);
    }
    if (f.tipo) {
      if (this.resolverTipos(f.tipo).length) aplicados.tipo = f.tipo;
      else avisos.push(`Tipo "${f.tipo}" não reconhecido; busca feita sem filtro de tipo.`);
    }
    if (f.preco_min) aplicados.preco_min = formatarBRL(f.preco_min);
    if (f.preco_max) aplicados.preco_max = formatarBRL(f.preco_max);
    for (const k of ['dormitorios_min', 'suites_min', 'vagas_min', 'area_min', 'codigo', 'texto_livre']) if (f[k]) aplicados[k] = f[k];

    // Bairro pedido não existe na carteira: não busca "às cegas"; oferece o vizinho.
    if (f.bairros && f.bairros.length && !bairros.length) {
      return this.alternativa(f, cidade, [], aplicados, avisos);
    }

    const corpo = this.montarCorpo(f, cidade, bairros);
    const r = await this.req('POST', '/Imovel/RetornarImoveisDisponiveis', { corpo });
    const total = r.quantidade || 0;
    const brutos = (r.lista || []).map((i) => ({ ...this.resumo(i), _bruto: i }));
    if (!brutos.length && !f.codigo) return this.alternativa(f, cidade, bairros, aplicados, avisos);

    const limite = Math.min(Math.max(+f.limite || 5, 1), 5);
    const escolhidos = await this.ranquear(brutos, f.texto_livre, limite);
    return { total_encontrado: total, imoveis: escolhidos, filtros_aplicados: aplicados, avisos };
  }

  // Remove duplicados, pontua desejos qualitativos e prioriza imóveis que já têm ficha no site.
  async ranquear(itens, textoLivre, limite) {
    const vistos = new Set();
    const unicos = itens.filter((x) => {
      const a = Imoview.assinatura(x);
      if (vistos.has(a)) return false;
      vistos.add(a);
      return true;
    });
    const t = norm(textoLivre || '');
    const flags = t ? PALAVRAS_FLAG.filter(([re]) => re.test(t)).flatMap(([, fl]) => fl) : [];
    const palavras = t ? t.split(' ').filter((p) => p.length >= 4) : [];
    const links = await this.site.resolver(unicos.map((x) => x.codigo));
    return unicos
      .map((x, idx) => {
        let s = 0;
        for (const fl of flags) if (x._bruto[fl] === true) s += 2;
        if (palavras.length) {
          const desc = norm(`${x._bruto.titulo} ${x._bruto.descricao}`);
          for (const p of palavras) if (desc.includes(p)) s += 1;
        }
        const l = links.get(String(x.codigo)) || {};
        return { x, s, pagina: l.pagina ? 1 : 0, url: l.url, idx };
      })
      .sort((a, b) => b.s - a.s || b.pagina - a.pagina || a.idx - b.idx)
      .slice(0, limite)
      .map(({ x, url, pagina }) => {
        const { _bruto, ...limpo } = x;
        return { ...limpo, url };
      });
  }

  // Recorte exato vazio: tenta um recorte vizinho e devolve como ALTERNATIVA.
  async alternativa(f, cidade, bairros, aplicados, avisos) {
    const vazio = (s) => ({ total_encontrado: 0, imoveis: [], filtros_aplicados: aplicados, avisos, sugestao_alternativa: s });
    const temCriterio = f.tipo || f.preco_max || f.preco_min || f.dormitorios_min || f.suites_min;
    const tentativas = [];

    // 1) mesmos critérios, outros bairros da mesma cidade
    const cidadeRef =
      cidade ||
      (bairros.length && bairros.every((b) => b.cidadeCodigo === bairros[0].cidadeCodigo)
        ? { codigo: bairros[0].cidadeCodigo, nome: bairros[0].cidade }
        : null);
    if ((bairros.length || (f.bairros && f.bairros.length)) && (cidadeRef || temCriterio)) {
      tentativas.push({ f: { ...f }, cidade: cidadeRef, bairros: [], explicacao: `mesmos critérios em outros bairros${cidadeRef ? ' de ' + cidadeRef.nome : ''}` });
    }
    // 2) teto de preço +20%
    if (f.preco_max) {
      tentativas.push({ f: { ...f, preco_max: Math.round(f.preco_max * 1.2) }, cidade, bairros, explicacao: `teto de preço ampliado em 20% (até ${formatarBRL(f.preco_max * 1.2)})` });
    }
    // 3) uma suíte a menos
    if (f.suites_min && f.suites_min > 1) {
      tentativas.push({ f: { ...f, suites_min: f.suites_min - 1 }, cidade, bairros, explicacao: `com ${f.suites_min - 1}+ suítes` });
    }

    if (!tentativas.length) {
      return vazio('Nada publicado nesse recorte. Pergunte se o cliente considera outra região próxima ou ofereça a busca dedicada de 24h.');
    }
    for (const t of tentativas.slice(0, 2)) {
      try {
        const r = await this.req('POST', '/Imovel/RetornarImoveisDisponiveis', { corpo: this.montarCorpo(t.f, t.cidade, t.bairros) });
        const brutos = (r.lista || []).map((i) => ({ ...this.resumo(i), _bruto: i }));
        if (!brutos.length) continue;
        const itens = (await this.ranquear(brutos, f.texto_livre, 3)).map((x) => ({ ...x, alternativa: true }));
        return {
          total_encontrado: 0,
          imoveis: itens,
          filtros_aplicados: aplicados,
          avisos,
          sugestao_alternativa: `Nada no recorte exato. Os imóveis listados são ALTERNATIVAS (${t.explicacao}) — deixe isso claro ao apresentar e ofereça também a busca dedicada de 24h.`,
        };
      } catch (e) {
        log('imoview_alternativa_erro', { erro: e.message });
      }
    }
    return vazio('Nada no recorte exato nem em recorte vizinho. Diga a verdade e ofereça a busca dedicada de 24h.');
  }

  async anexarLinks(itens) {
    if (!itens.length) return;
    const links = await this.site.resolver(itens.map((x) => x.codigo));
    for (const x of itens) {
      const l = links.get(String(x.codigo)) || {};
      x.url = l.url;
    }
  }

  // ---------- ficha ----------
  async detalhar(codigo) {
    const cod = String(codigo || '').replace(/\D/g, '');
    if (!cod) return null;
    const r = await this.req('GET', '/Imovel/RetornarDetalhesImovelDisponivel', { query: { codigoImovel: cod } });
    const i = r && (r.imovel || (r.codigo ? r : null));
    if (!i || !i.codigo) return null;
    const base = this.resumo(i);
    const diferenciais = Object.entries(DIFERENCIAIS)
      .filter(([k]) => i[k] === true)
      .map(([, v]) => v);
    if (parseNumBR(i.numeroelevador) > 0) diferenciais.push('elevador');
    const descricao = limparDescricao(i.descricao).slice(0, 1400);
    const ficha = {
      ...base,
      titulo: limparTitulo(i.titulo),
      situacao: i.situacao,
      condominio_mensal: parseValorBR(i.valorcondominio) ? formatarBRL(parseValorBR(i.valorcondominio)) : 'não informado',
      iptu_anual: parseValorBR(i.valoriptuanual) ? formatarBRL(parseValorBR(i.valoriptuanual)) : 'não informado',
      tipo_vagas: i.tipovagas || undefined,
      andar: i.numeroandar || undefined,
      ano_construcao: i.anoconstrucao || undefined,
      diferenciais,
      aceita_financiamento: !!i.aceitafinanciamento,
      aceita_permuta: !!i.aceitapermuta,
      descricao,
      quantidade_fotos: Array.isArray(i.fotos) ? i.fotos.length : 0,
      unidade_responsavel: String(i.nomeunidade || '').trim() || undefined,
      codigo_unidade: i.unidade || undefined,
    };
    await this.anexarLinks([ficha]);
    return ficha;
  }

  // ---------- lead no CRM ----------
  async incluirLead({ nome, telefone, email, finalidade, codigoImovel, anotacoes }) {
    const corpo = {
      nome: nome || 'Cliente WhatsApp',
      telefone: foneNacional(telefone),
      email: email || '',
      midia: this.cfg.midiaLead,
      finalidade: finalidade === 'locacao' ? '1' : '2',
      anotacoes: String(anotacoes || '').slice(0, 3000),
    };
    if (codigoImovel) corpo.codigoimovel = String(codigoImovel);
    if (this.cfg.codigoUnidadeLead) corpo.codigounidade = String(this.cfg.codigoUnidadeLead);
    if (this.cfg.emailCorretorLead) corpo.emailcorretor = this.cfg.emailCorretorLead;
    return this.req('POST', '/Lead/IncluirLead', { corpo, tentativas: 1 });
  }
}

module.exports = { Imoview, casaNome, GRUPOS_TIPO, DIFERENCIAIS, PALAVRAS_FLAG, limparDescricao, levenshtein };
