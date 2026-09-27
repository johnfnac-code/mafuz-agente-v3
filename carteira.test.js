'use strict';
// Carteira inteira e busca por lugar (sem Imoview de verdade: um CRM falso com falhas).
// Rode: node --test test/carteira.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Catalogo } = require('../src/catalogo');
const { Imoview } = require('../src/imoview');
const { SiteLinks } = require('../src/site');

const LUGARES = [
  ['Vila da Serra', 'Nova lima'], ['Vale do Sereno', 'Nova lima'], ['Alphaville  Lagoa dos Ingleses', 'Nova lima'],
  ['Condomínio Alphaville Vespasiano', 'Vespasiano'], ['Condomínio Gran Royalle', 'Lagoa Santa'], ['Condomínio Gran Royalle', 'Confins'],
  ['Belvedere', 'Belo Horizonte'], ['Lourdes', 'Belo Horizonte'], ['Serra', 'Belo Horizonte'], ['Sion', 'Belo Horizonte'],
  ['Solar da Lagoa', 'Nova lima'], ['Bandeirantes (Pampulha)', 'Belo Horizonte'], ['Condomínio Retiro do Chalé', 'Brumadinho'],
];

// 2.700 imóveis, 20 por página; 1 em cada 6 páginas falha na primeira vez (como um 429 do Imoview).
function crmFalso(total = 2700) {
  const base = Array.from({ length: total }, (_, k) => {
    const [bairro, cidade] = LUGARES[k % LUGARES.length];
    return {
      codigo: 10000 + k, finalidade: k % 9 === 0 ? 'Aluguel' : 'Venda', tipo: k % 2 ? 'Apartamento' : 'Casa em condomínio',
      bairro, cidade, codigobairro: bairro, codigocidade: cidade, valor: `R$ ${(1000000 + k * 1000).toLocaleString('pt-BR')},00`,
      numeroquartos: 3 + (k % 3), numerosuites: 2 + (k % 3), numerovagas: 3, areaprincipal: '250', titulo: `Imóvel ${k}`, descricao: 'Lindo imóvel.',
    };
  });
  const falhou = new Set();
  const imoview = new Imoview({ baseUrl: 'http://x', chave: 'x' }, null);
  imoview.garantirListas = async () => ({});
  imoview.req = async (metodo, caminho, { corpo, query } = {}) => {
    if (caminho.includes('Detalhes')) return { imovel: base.find((b) => String(b.codigo) === String(query.codigoImovel)) || null };
    const lista = base.filter((b) => (corpo.finalidade === 1) === /alug/i.test(b.finalidade));
    const chave = `${corpo.finalidade}-${corpo.numeroPagina}`;
    if (corpo.numeroPagina > 1 && corpo.numeroPagina % 6 === 0 && !falhou.has(chave)) {
      falhou.add(chave);
      throw new Error('Imoview HTTP 429');
    }
    const ini = (corpo.numeroPagina - 1) * 20;
    return { quantidade: lista.length, lista: lista.slice(ini, ini + 20) };
  };
  return { imoview, base, falhou };
}

const site = new SiteLinks({ url: 'https://mafuz.site' });
site.carregarTodos = async () => 0;

async function carteira() {
  const crm = crmFalso();
  const cat = new Catalogo({ imoview: crm.imoview, site, config: {} });
  cat.pagina = (fin, n) => crm.imoview.req('POST', '/Imovel/RetornarImoveisDisponiveis', { corpo: { finalidade: fin, numeroPagina: n, numeroRegistros: 20 } });
  await cat.sincronizar();
  return { cat, crm };
}

test('sincronização traz a carteira inteira mesmo com páginas que falham', async () => {
  const { cat, crm } = await carteira();
  assert.ok(crm.falhou.size > 10, 'o teste precisa ter falhas');
  assert.strictEqual(cat.itens.length, 2700);
  assert.strictEqual(cat.esperado, 2700);
  assert.strictEqual(cat.completa, true);
});

test('todo bairro e condomínio da carteira é encontrável pelo nome', async () => {
  const { cat } = await carteira();
  for (const [bairro] of LUGARES) {
    const nome = bairro.replace(/^Condomínio /, '');
    const r = await cat.buscar({ finalidade: 'venda', bairros: [nome] });
    assert.ok(r.total_encontrado > 0 && !r.sugestao_alternativa, `${nome}: ${JSON.stringify(r.filtros_aplicados)}`);
  }
});

test('lugares do jeito que o cliente fala', async () => {
  const { cat } = await carteira();
  const buscar = (f) => cat.buscar({ finalidade: 'venda', ...f });
  // cidade errada junto do bairro: o bairro manda
  let r = await buscar({ bairros: ['vila da serra'], cidade: 'Belo Horizonte' });
  assert.ok(r.imoveis.every((i) => i.bairro === 'Vila da Serra'));
  // "Alphaville" pega Nova Lima e Vespasiano
  r = await buscar({ bairros: ['Alphaville'], limite: 6 });
  assert.deepStrictEqual(new Set(r.filtros_aplicados.local.map((x) => x.split(' (').pop())).size >= 2, true);
  // região
  r = await buscar({ bairros: ['Seis Pistas'] });
  assert.ok(r.total_encontrado > 0 && r.imoveis.every((i) => ['Vila da Serra', 'Vale do Sereno', 'Belvedere'].includes(i.bairro)));
  // cidade passada como bairro
  r = await buscar({ bairros: ['Lagoa Santa'] });
  assert.ok(r.imoveis.every((i) => i.cidade === 'Lagoa Santa'));
  // erro de digitação
  r = await buscar({ bairros: ['Solr da Lagoa'] });
  assert.ok(r.total_encontrado > 0 && r.imoveis.every((i) => i.bairro === 'Solar da Lagoa'));
  // "Vila da Serra" não pode virar "Serra" (BH)
  r = await buscar({ bairros: ['Vila da Serra'] });
  assert.ok(r.imoveis.every((i) => i.bairro === 'Vila da Serra'));
  // código: acha mesmo com a finalidade errada
  r = await buscar({ codigo: '10009', finalidade: 'venda' });
  assert.strictEqual(r.imoveis[0].codigo, '10009');
});

test('link sempre é a página exata do imóvel no site', async () => {
  const { cat } = await carteira();
  const r = await cat.buscar({ finalidade: 'venda', bairros: ['Lourdes'] });
  for (const i of r.imoveis) assert.strictEqual(i.url, `https://mafuz.site/imovel/${i.codigo}`);
  assert.strictEqual(site.codigoDoLink('Olha esse https://mafuz.site/imovel/12345?utm_source=x'), '12345');
});
