'use strict';
// Gera o link público do imóvel no site da MAFUZ.
// A página do imóvel no site usa o id interno da plataforma (/imovel/<uuid>), e cada
// imóvel sincronizado guarda o código do Imoview em "external_id". Consultamos a mesma
// API pública (somente leitura, chave "anon") que o próprio site usa no navegador.

const { log } = require('./util');

const TTL_MS = 6 * 3600000;

class SiteLinks {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();
  }

  // Carrega de uma vez o mapa código do Imoview -> página do site (usado na sincronização do catálogo).
  async carregarTodos() {
    if (!this.cfg.supabaseUrl || !this.cfg.supabaseAnonKey) return 0;
    const agora = Date.now();
    let total = 0;
    for (let offset = 0; offset < 20000; offset += 1000) {
      const url = `${this.cfg.supabaseUrl}/rest/v1/properties?select=id,external_id&status=eq.published&external_id=not.is.null&order=id&limit=1000&offset=${offset}`;
      const r = await fetch(url, {
        headers: { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`site HTTP ${r.status}`);
      const linhas = await r.json();
      for (const row of linhas) this.cache.set(String(row.external_id), { url: `${this.cfg.url}/imovel/${row.id}`, ts: agora });
      total += linhas.length;
      if (linhas.length < 1000) break;
    }
    return total;
  }

  /** Código do Imoview a partir do link /imovel/<uuid> do site (mensagens prontas do site). */
  codigoDoLink(texto) {
    const direto = (String(texto || '').match(/\/imovel\/(\d{2,9})(?![\w-])/) || [])[1];
    if (direto) return direto;
    const id = (String(texto || '').match(/\/imovel\/([0-9a-f-]{36})/i) || [])[1];
    if (!id) return null;
    for (const [codigo, v] of this.cache) if (v && v.url && v.url.endsWith(`/imovel/${id}`) && !codigo.startsWith('capa:')) return codigo;
    return null;
  }

  // Leitura instantânea (sem rede) para o catálogo local.
  linkLocal(codigo) {
    const hit = this.cache.get(String(codigo));
    return hit ? { url: hit.url, pagina: true } : { url: this.fallback(codigo), pagina: false };
  }

  // Página exata pelo código do Imoview: o site abre a ficha (mafuz.site/imovel/12345) e,
  // se o imóvel acabou de entrar no CRM e ainda não tem ficha, mostra o aviso com o WhatsApp.
  fallback(codigo) {
    return `${this.cfg.url}/imovel/${encodeURIComponent(String(codigo).replace(/\D/g, ''))}`;
  }

  // Foto de capa do imóvel no site (a mesma que aparece na ficha).
  async capa(codigo, url) {
    const chave = `capa:${codigo}`;
    const hit = this.cache.get(chave);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.url;
    if (!this.cfg.supabaseUrl || !this.cfg.supabaseAnonKey) return null;
    const h = { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}` };
    try {
      let id = (String(url || '').match(/\/imovel\/([0-9a-f-]{36})/i) || [])[1];
      if (!id) {
        const r = await fetch(`${this.cfg.supabaseUrl}/rest/v1/properties?select=id&status=eq.published&external_id=eq.${encodeURIComponent(codigo)}&limit=1`, { headers: h, signal: AbortSignal.timeout(8000) });
        id = r.ok ? ((await r.json())[0] || {}).id : null;
      }
      if (!id) return null;
      const r = await fetch(
        `${this.cfg.supabaseUrl}/rest/v1/property_images?select=file_url&property_id=eq.${id}&order=is_cover.desc,sort_order.asc&limit=1`,
        { headers: h, signal: AbortSignal.timeout(8000) }
      );
      const foto = r.ok ? ((await r.json())[0] || {}).file_url : null;
      if (foto) this.cache.set(chave, { url: foto, ts: Date.now() });
      return foto || null;
    } catch (e) {
      log('site_capa_erro', { codigo, erro: e.message });
      return null;
    }
  }

  // Retorna Map codigo -> { url, pagina } (pagina=false quando o imóvel ainda não tem ficha no site).
  async resolver(codigos) {
    const saida = new Map();
    const faltam = [];
    const agora = Date.now();
    for (const c of codigos.map(String)) {
      const hit = this.cache.get(c);
      if (hit && agora - hit.ts < TTL_MS) saida.set(c, { url: hit.url, pagina: true });
      else faltam.push(c);
    }
    if (faltam.length && this.cfg.supabaseUrl && this.cfg.supabaseAnonKey) {
      try {
        const lista = faltam.map((c) => `"${c.replace(/"/g, '')}"`).join(',');
        const url =
          `${this.cfg.supabaseUrl}/rest/v1/properties?select=id,external_id` +
          `&status=eq.published&external_id=in.(${encodeURIComponent(lista)})`;
        const r = await fetch(url, {
          headers: { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          for (const row of await r.json()) {
            const link = `${this.cfg.url}/imovel/${row.id}`;
            this.cache.set(String(row.external_id), { url: link, ts: agora });
            saida.set(String(row.external_id), { url: link, pagina: true });
          }
        } else {
          log('site_links_http', { status: r.status });
        }
      } catch (e) {
        log('site_links_erro', { erro: e.message });
      }
    }
    for (const c of codigos.map(String)) if (!saida.has(c)) saida.set(c, { url: this.fallback(c), pagina: false });
    return saida;
  }
}

module.exports = { SiteLinks };
