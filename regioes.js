'use strict';
// Como o cliente fala de lugar -> como a carteira da MAFUZ cadastra.
// O cliente diz "Seis Pistas", "Zona Sul", "Pampulha", "Lagoa dos Ingleses" ou "Alphaville";
// no Imoview isso vira bairros, condomínios e cidades. Este módulo resolve qualquer
// um desses termos contra o ÍNDICE REAL da carteira (montado a cada sincronização),
// então todo bairro/condomínio que tiver imóvel publicado é encontrável.

const { norm } = require('./util');
const { casaNome, levenshtein } = require('./imoview');

// Regiões que não existem como bairro no cadastro. bairros: nomes como estão no Imoview.
const REGIOES = [
  {
    nomes: ['zona sul', 'centro sul', 'regiao centro sul', 'regiao sul de bh', 'sul de bh', 'zona sul de bh'],
    cidade: 'belo horizonte',
    bairros: ['Anchieta', 'Barro Preto', 'Belvedere', 'Boa Viagem', 'Carmo', 'Centro', 'Cidade Jardim', 'Comiteco', 'Coração de Jesus', 'Cruzeiro', 'Funcionários', 'Lourdes', 'Luxemburgo', 'Mangabeiras', 'Santa Efigênia', 'Santa Lúcia', 'Santo Agostinho', 'Santo Antônio', 'São Bento', 'São Lucas', 'São Pedro', 'Savassi', 'Serra', 'Sion', 'Vila Paris'],
  },
  {
    nomes: ['regiao oeste', 'zona oeste', 'oeste de bh'],
    cidade: 'belo horizonte',
    bairros: ['Gutierrez', 'Buritis', 'Prado', 'Estoril', 'Grajaú', 'Nova Suíssa', 'Calafate', 'Nova Granada', 'Vila Oeste', 'Palmeiras', 'Havaí'],
  },
  {
    nomes: ['pampulha', 'regiao da pampulha', 'lagoa da pampulha', 'orla da pampulha'],
    cidade: 'belo horizonte',
    bairros: ['Bandeirantes (Pampulha)', 'Bandeirantes', 'São Luiz', 'Braúnas', 'Castelo', 'Jardim Atlântico', 'Santa Amélia', 'Itapoã', 'Garças', 'Trevo', 'Engenho Nogueira', 'Santa Inês', 'Liberdade', 'Ouro Preto', 'Pampulha'],
  },
  {
    nomes: ['seis pistas', '6 pistas', 'bh shopping', 'regiao do bh shopping', 'divisa bh nova lima', 'divisa com nova lima'],
    bairros: ['Vila da Serra', 'Vale do Sereno', 'Jardim da Torre', 'Belvedere', 'Olhos d\'Água', 'Vila Castela'],
  },
  {
    nomes: ['vetor sul', 'eixo sul', 'mg 030', 'mg030', 'br 040', 'br040', 'condominios de nova lima', 'condominios da br 040'],
    bairros: ['Vila da Serra', 'Vale do Sereno', 'Jardim da Torre', 'Vila Castela', 'Vale dos Cristais', 'Piemonte', 'Alphaville Lagoa dos Ingleses', 'Quintas do Sol', 'Vila Alpina', 'Vila Del Rey', 'Mirante da Mata', 'Jardim das Mangabeiras', 'Ville de Montagne', 'Bosque da Ribeira', 'Village Terrasse', 'Residencial Três Vales', 'Serra do Curral Del Rey', 'Estância Serrana', 'Morro do Chapéu', 'Pasárgada', 'Ouro Velho Mansões', 'Riviera', 'Le Cottage', 'Canto da Mata', 'Veredas das Geraes'],
  },
  {
    nomes: ['vetor norte', 'regiao de lagoa santa', 'linha verde', 'regiao do aeroporto', 'aeroporto de confins'],
    cidades: ['lagoa santa', 'vespasiano', 'confins', 'jaboticatubas', 'pedro leopoldo'],
  },
  {
    nomes: ['lagoa dos ingleses', 'alphaville nova lima', 'alphaville lagoa dos ingleses'],
    bairros: ['Alphaville Lagoa dos Ingleses'],
  },
  {
    nomes: ['alphaville vespasiano'],
    bairros: ['Condomínio Alphaville Vespasiano', 'Condomínio Alphaville'],
  },
  {
    nomes: ['serra do cipo', 'cipo'],
    cidades: ['jaboticatubas', 'santana do riacho'],
  },
  {
    nomes: ['trancoso', 'bahia', 'litoral'],
    cidades: ['porto seguro', 'trancoso', 'belmonte', 'santo amaro'],
  },
];

// Lugares sem imóvel publicado hoje -> onde procurar por perto (entra como ALTERNATIVA).
const VIZINHOS = [
  { nomes: ['olhos d agua', 'olhos dagua'], bairros: ['Belvedere', 'Vila da Serra', 'Vale do Sereno', 'Jardim da Torre'] },
  { nomes: ['jardim canada', 'retiro das pedras'], bairros: ['Vale do Sereno', 'Vila da Serra', 'Piemonte', 'Vale dos Cristais'], cidades: [] },
  { nomes: ['sao sebastiao das aguas claras', 'macacos'], bairros: ['São Sebastião das Aguas Claras', 'Canto das Águas', 'Pasárgada', 'Vale dos Cristais'] },
  { nomes: ['buritis', 'estoril'], bairros: ['Buritis', 'Estoril', 'Gutierrez', 'Prado'] },
  { nomes: ['cidade nova', 'uniao', 'uniao bh'], bairros: ['Cidade Nova', 'União', 'Palmares'] },
];

const ALIAS_CIDADE = { bh: 'belo horizonte', 'b h': 'belo horizonte', beaga: 'belo horizonte', 'belo horizonte mg': 'belo horizonte' };

const soNome = (s) => norm(s).replace(/\b(condominio|residencial|bairro|regiao|do|da|de|dos|das)\b/g, ' ').replace(/\s+/g, ' ').trim();

class IndiceRegioes {
  /** itens: catálogo compactado (bairro, bairroNorm, codigoBairro, cidade, codigoCidade, condominio, titulo). */
  constructor(itens = []) {
    this.bairros = new Map(); // chave bairroNorm|cidadeNorm -> { nome, cidade, n, codigo }
    this.cidades = new Map(); // cidadeNorm -> { nome, codigo, n }
    this.condominios = new Map(); // condNorm -> Set(codigo imóvel)
    for (const i of itens) {
      const cn = norm(i.cidade);
      if (cn) {
        const c = this.cidades.get(cn) || { nome: i.cidade, codigo: i.codigoCidade, n: 0 };
        c.n++;
        this.cidades.set(cn, c);
      }
      if (i.bairroNorm) {
        const k = `${i.bairroNorm}|${cn}`;
        const b = this.bairros.get(k) || { nome: i.bairro, cidade: i.cidade, cidadeNorm: cn, bairroNorm: i.bairroNorm, codigo: i.codigoBairro, n: 0 };
        b.n++;
        this.bairros.set(k, b);
      }
      const cond = norm(i.condominio || '');
      if (cond.length >= 4) {
        if (!this.condominios.has(cond)) this.condominios.set(cond, new Set());
        this.condominios.get(cond).add(i.codigo);
      }
    }
  }

  cidade(nome) {
    if (!nome) return null;
    const q = ALIAS_CIDADE[norm(nome)] || norm(nome);
    let melhor = null;
    for (const [cn, c] of this.cidades) {
      const s = cn === q ? 1 : casaNome(q, cn);
      if (s >= 0.85 && (!melhor || s > melhor.s || (s === melhor.s && c.n > melhor.n))) melhor = { ...c, norm: cn, s };
    }
    return melhor;
  }

  bairrosPorNome(nome, cidadeNorm) {
    const q = soNome(nome);
    if (!q) return [];
    const cands = [];
    for (const b of this.bairros.values()) {
      if (cidadeNorm && b.cidadeNorm !== cidadeNorm) continue;
      const alvo = soNome(b.nome);
      let s = alvo === q ? 1 : casaNome(q, alvo);
      // Erro de digitação no nome inteiro ("Solr da Lagoa", "Vile de Montagne").
      if (s < 1 && q.length >= 6) {
        const r = 1 - levenshtein(q, alvo) / Math.max(q.length, alvo.length);
        if (r >= 0.8) s = Math.max(s, r * 0.95);
      }
      // "vila serra" não é "serra": o pedido contendo um nome curto não vale como acerto.
      if (s && !alvo.includes(q) && q.includes(alvo) && alvo.length < q.length * 0.7) s = 0;
      if (!s && q.length >= 5 && alvo.includes(q)) s = 0.8;
      const contem = q.length >= 5 && ` ${alvo} `.includes(` ${q} `);
      if (s >= 0.6) cands.push({ ...b, s, contem });
    }
    if (!cands.length) return [];
    cands.sort((a, b) => b.s - a.s || b.n - a.n);
    const topo = cands[0].s;
    // Nome exato: fica com ele e com os cadastros que contêm o nome inteiro
    // ("Alphaville" -> Alphaville Lagoa dos Ingleses e Alphaville Vespasiano). Senão, os mais próximos.
    return cands.filter((c) => (topo === 1 ? c.s >= 0.86 || c.contem : c.s >= topo - 0.1)).slice(0, 8);
  }

  /**
   * Resolve os termos de lugar do cliente.
   * Retorna { alvo: { bairros:Set<chave>, cidades:Set<cidadeNorm>, imoveis:Set<codigo>, texto:[termos] }, aplicados:[rótulos], avisos:[] }
   */
  resolver(termos = [], cidadePedida = null) {
    const alvo = { bairros: new Set(), cidades: new Set(), imoveis: new Set(), texto: [] };
    const aplicados = [];
    const avisos = [];
    const cidadeRef = cidadePedida ? this.cidade(cidadePedida) : null;

    for (const termo of termos.filter(Boolean)) {
      const t = norm(termo).replace(/^(regiao|bairro|condominio) (do |da |de )?/, '');
      let achou = false;

      // 1) Região conhecida (Zona Sul, Seis Pistas, Pampulha, Vetor Norte...)
      const reg = REGIOES.find((r) => r.nomes.some((n) => t === n || (n.length >= 6 && t.includes(n))));
      if (reg) {
        for (const c of reg.cidades || []) {
          const cid = this.cidade(c);
          if (cid) alvo.cidades.add(cid.norm);
        }
        const cidReg = reg.cidade ? norm(reg.cidade) : null;
        for (const nome of reg.bairros || []) {
          for (const b of this.bairrosPorNome(nome, cidReg).filter((x) => x.s >= 0.85)) alvo.bairros.add(`${b.bairroNorm}|${b.cidadeNorm}`);
        }
        aplicados.push(`${termo} (região)`);
        achou = true;
      }

      // 2) O "bairro" é na verdade uma cidade (ex.: "Lagoa Santa", "Nova Lima")
      if (!achou) {
        const cid = this.cidade(t);
        if (cid && cid.s >= 0.95) {
          alvo.cidades.add(cid.norm);
          aplicados.push(cid.nome);
          achou = true;
        }
      }

      // 3) Bairro ou condomínio cadastrado como bairro (na cidade pedida; se não houver, em qualquer cidade)
      if (!achou) {
        let bs = this.bairrosPorNome(t, cidadeRef && cidadeRef.norm);
        const global = cidadeRef ? this.bairrosPorNome(t, null) : [];
        const exatoFora = global.length && global[0].s === 1 && (!bs.length || bs[0].s < 1);
        if ((!bs.length || exatoFora) && cidadeRef) {
          bs = global;
          if (bs.length) avisos.push(`"${termo}" fica em ${[...new Set(bs.map((b) => b.cidade))].join(', ')}, não em ${cidadeRef.nome}; busquei lá.`);
        }
        if (bs.length) {
          for (const b of bs) alvo.bairros.add(`${b.bairroNorm}|${b.cidadeNorm}`);
          aplicados.push(...bs.map((b) => `${b.nome} (${b.cidade})`));
          achou = true;
        }
      }

      // 4) Nome de condomínio/edifício no cadastro do imóvel
      if (!achou) {
        const q = soNome(t);
        for (const [cond, cods] of this.condominios) {
          if (q.length >= 4 && (cond.includes(q) || casaNome(q, cond) >= 0.85)) for (const c of cods) alvo.imoveis.add(c);
        }
        if (alvo.imoveis.size) {
          aplicados.push(`${termo} (condomínio)`);
          achou = true;
        }
      }

      // 5) Última tentativa: o nome aparece no título ou na descrição do anúncio
      if (!achou && soNome(t).length >= 4) {
        alvo.texto.push(soNome(t));
        aplicados.push(`${termo} (citado no anúncio)`);
      }
    }
    // Região de cada bairro pedido (para sugerir vizinhos antes da cidade inteira).
    const vizinhos = { bairros: new Set(), cidades: new Set(), imoveis: new Set(), texto: [] };
    for (const termo of termos.filter(Boolean)) {
      const t = norm(termo);
      const v = VIZINHOS.find((x) => x.nomes.some((n) => t === n || t.includes(n)));
      const lista = v ? v.bairros : [];
      for (const r of REGIOES.filter((r) => r.bairros && r.bairros.some((b) => soNome(b) === soNome(t)))) lista.push(...r.bairros);
      for (const nome of lista) for (const b of this.bairrosPorNome(nome, null).filter((x) => x.s === 1)) vizinhos.bairros.add(`${b.bairroNorm}|${b.cidadeNorm}`);
    }
    for (const k of alvo.bairros) vizinhos.bairros.delete(k);
    const vazio = !alvo.bairros.size && !alvo.cidades.size && !alvo.imoveis.size && !alvo.texto.length;
    return { alvo, aplicados, avisos, vazio, cidade: cidadeRef, vizinhos: vizinhos.bairros.size ? vizinhos : null };
  }

  /** O imóvel está no lugar pedido? */
  static atende(i, alvo) {
    if (!alvo) return true;
    const cn = norm(i.cidade);
    if (alvo.cidades.has(cn)) return true;
    if (alvo.bairros.has(`${i.bairroNorm}|${cn}`)) return true;
    if (alvo.imoveis.has(i.codigo)) return true;
    if (alvo.texto.length && alvo.texto.some((t) => i.texto.includes(t) || norm(i.condominio || '').includes(t))) return true;
    return false;
  }
}

module.exports = { IndiceRegioes, REGIOES };
