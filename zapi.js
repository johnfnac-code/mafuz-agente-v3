'use strict';
// Cliente mínimo da Z-API (https://developer.z-api.io).

const { log, sleep } = require('./util');

class ZApi {
  constructor(cfg) {
    this.cfg = cfg;
  }

  url(caminho) {
    const { baseUrl, instancia, token } = this.cfg;
    return `${baseUrl}/instances/${instancia}/token/${token}/${caminho}`;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.cfg.clientToken) h['Client-Token'] = this.cfg.clientToken;
    return h;
  }

  async chamar(metodo, caminho, corpo, tentativas = 2) {
    let ultimoErro;
    for (let i = 0; i < tentativas; i++) {
      try {
        const r = await fetch(this.url(caminho), {
          method: metodo,
          headers: this.headers(),
          body: corpo ? JSON.stringify(corpo) : undefined,
          signal: AbortSignal.timeout(25000),
        });
        const texto = await r.text();
        let json;
        try {
          json = JSON.parse(texto);
        } catch {
          json = { bruto: texto };
        }
        if (!r.ok) {
          ultimoErro = new Error(`Z-API ${caminho} HTTP ${r.status}: ${texto.slice(0, 300)}`);
          if (r.status < 500) break;
        } else {
          return json;
        }
      } catch (e) {
        ultimoErro = e;
      }
      await sleep(800 * (i + 1));
    }
    throw ultimoErro;
  }

  // delayTyping (1–15 s) mostra "digitando..." antes de entregar a mensagem.
  async enviarTexto(fone, mensagem, { delayTyping } = {}) {
    const corpo = { phone: String(fone), message: mensagem };
    if (delayTyping) corpo.delayTyping = Math.max(1, Math.min(15, Math.round(delayTyping)));
    const r = await this.chamar('POST', 'send-text', corpo);
    log('zapi_enviado', { fone: mascarar(fone), chars: mensagem.length, messageId: r && r.messageId });
    return r;
  }

  // Foto com legenda. `imagem` pode ser uma URL pública ou um data URI em base64.
  async enviarImagem(fone, imagem, legenda, { delayTyping } = {}) {
    const corpo = { phone: String(fone), image: imagem, caption: legenda || '' };
    if (delayTyping) corpo.delayTyping = Math.max(1, Math.min(15, Math.round(delayTyping)));
    const r = await this.chamar('POST', 'send-image', corpo);
    log('zapi_imagem', { fone: mascarar(fone), chars: (legenda || '').length, messageId: r && r.messageId });
    return r;
  }

  // Vídeo por URL pública (a Z-API baixa o arquivo). Legenda igual à do cartão.
  async enviarVideo(fone, videoUrl, legenda, { delayTyping } = {}) {
    const corpo = { phone: String(fone), video: videoUrl, caption: legenda || '' };
    if (delayTyping) corpo.delayTyping = Math.max(1, Math.min(15, Math.round(delayTyping)));
    const r = await this.chamar('POST', 'send-video', corpo);
    log('zapi_video', { fone: mascarar(fone), messageId: r && r.messageId });
    return r;
  }

  async status() {
    return this.chamar('GET', 'status', null, 1);
  }

  // Com notificarEnviadasPorMim = true, a Z-API também avisa quando alguém da equipe
  // responde pelo celular/WhatsApp Web — é assim que o robô sabe que deve se calar.
  async configurarWebhook(url, { notificarEnviadasPorMim = true } = {}) {
    const caminho = notificarEnviadasPorMim ? 'update-webhook-received-delivery' : 'update-webhook-received';
    return this.chamar('PUT', caminho, { value: url }, 1);
  }
}

function mascarar(fone) {
  const s = String(fone);
  return s.length > 6 ? s.slice(0, 4) + '•••' + s.slice(-3) : s;
}

module.exports = { ZApi, mascarar };
