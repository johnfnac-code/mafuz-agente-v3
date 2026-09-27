'use strict';
// Vídeos e fotos do Instagram da MAFUZ para o site (@mafuzimoveisdeluxo).
// Usa a API do Instagram com login do Instagram (conta Profissional/Comercial):
//   INSTAGRAM_TOKEN = token de longa duração (60 dias). O servidor renova sozinho
//   a cada 20 dias e guarda o token novo em DATA_DIR/instagram.json.
// Sem token, o site mostra só o atalho para o perfil.

const fs = require('fs');
const path = require('path');
const { log } = require('./util');

const GRAPH = 'https://graph.instagram.com';

class Instagram {
  constructor({ token, dir, perfil = 'mafuzimoveisdeluxo', cacheMin = 30 }) {
    this.arquivo = path.join(dir, 'instagram.json');
    this.perfil = perfil;
    this.cacheMs = cacheMin * 60000;
    this.cache = { ts: 0, itens: [] };
    this.estado = { token: token || '', renovadoEm: 0 };
    try {
      if (fs.existsSync(this.arquivo)) {
        const d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
        // Token salvo (renovado) vale mais que o da variável, se for mais novo.
        if (d.token && d.renovadoEm) this.estado = d;
      }
    } catch {}
  }

  ativo() {
    return !!this.estado.token;
  }

  async renovarSePreciso() {
    if (!this.estado.token || Date.now() - (this.estado.renovadoEm || 0) < 20 * 86400000) return;
    try {
      const r = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(this.estado.token)}`, { signal: AbortSignal.timeout(10000) });
      const d = await r.json();
      if (d.access_token) {
        this.estado = { token: d.access_token, renovadoEm: Date.now() };
        fs.writeFileSync(this.arquivo, JSON.stringify(this.estado));
        log('instagram_token_renovado', {});
      }
    } catch (e) {
      log('instagram_erro_renovar', { erro: e.message });
    }
  }

  static normalizar(m) {
    const video = m.media_type === 'VIDEO';
    return {
      id: m.id,
      tipo: video ? 'video' : m.media_type === 'CAROUSEL_ALBUM' ? 'album' : 'imagem',
      midia: m.media_url || '',
      capa: video ? m.thumbnail_url || '' : m.media_url || '',
      link: m.permalink || '',
      legenda: String(m.caption || '').split('\n')[0].slice(0, 160),
      data: m.timestamp || '',
    };
  }

  async itens({ somenteVideos = false } = {}) {
    if (!this.ativo()) return [];
    if (Date.now() - this.cache.ts > this.cacheMs) {
      await this.renovarSePreciso();
      try {
        const campos = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp';
        const r = await fetch(`${GRAPH}/me/media?fields=${campos}&limit=30&access_token=${encodeURIComponent(this.estado.token)}`, { signal: AbortSignal.timeout(12000) });
        const d = await r.json();
        if (Array.isArray(d.data)) this.cache = { ts: Date.now(), itens: d.data.map(Instagram.normalizar).filter((i) => i.midia) };
        else log('instagram_erro', { erro: JSON.stringify(d.error || d).slice(0, 200) });
      } catch (e) {
        log('instagram_erro', { erro: e.message });
      }
    }
    return somenteVideos ? this.cache.itens.filter((i) => i.tipo === 'video') : this.cache.itens;
  }
}

module.exports = { Instagram };
