'use strict';
// Vídeo vertical automático (1080x1920, 15 s) de cada imóvel novo da carteira.
//
// Usa o ffmpeg do servidor: até 5 fotos do Imoview com aproximação lenta e
// fusão entre elas, a identidade MAFUZ no topo, a legenda do imóvel embaixo e
// um cartão final com o convite para a visita. Sem áudio (a trilha entra no
// Instagram, que tem biblioteca licenciada). Os vídeos ficam no volume de dados
// e são servidos em /video/<codigo>.mp4 para o Reels e para a Gabi enviar.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./util');

const W = 1080;
const H = 1920;
const FPS = 30;
const DURACAO = 15;
const FUSAO = 0.5;

const FONTE_LEVE = path.join(__dirname, '..', 'assets', 'fontes', 'Jost-Light.ttf');
const FONTE = path.join(__dirname, '..', 'assets', 'fontes', 'Jost-Regular.ttf');

// drawtext: escapa \ : ' % e vírgula dentro de filtros
const esc = (t) =>
  String(t || '')
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');

const espacar = (t) => String(t).toUpperCase().split('').join(' ');

function textos(item) {
  const lote = /lote|terreno/i.test(item.tipo || '');
  const medidas = [
    !lote && item.dormitorios ? `${item.dormitorios} ${item.dormitorios === 1 ? 'quarto' : 'quartos'}` : '',
    !lote && item.suites ? `${item.suites} ${item.suites === 1 ? 'suíte' : 'suítes'}` : '',
    item.area_m2 ? `${Math.round(item.area_m2).toLocaleString('pt-BR')} m²` : item.area_lote_m2 ? `lote ${Math.round(item.area_lote_m2).toLocaleString('pt-BR')} m²` : '',
    !lote && item.vagas ? `${item.vagas} vagas` : '',
  ].filter(Boolean);
  const preco = item.preco_formatado && !/sob consulta/i.test(item.preco_formatado) ? item.preco_formatado + (item.finalidade === 'locacao' ? '/mês' : '') : 'Valor sob consulta';
  return {
    local: [item.condominio || item.bairro, item.cidade].filter(Boolean).join(' · ').toUpperCase(),
    tipo: `${item.tipo || 'Imóvel'} ${item.finalidade === 'locacao' ? 'para alugar' : 'à venda'}`.toUpperCase(),
    medidas: medidas.join('  ·  '),
    preco,
    codigo: `CÓD. ${item.codigo}`,
  };
}

/** Monta os argumentos do ffmpeg (exportado para teste). */
function argumentosFfmpeg(fotos, item, saida) {
  const n = fotos.length;
  // cada foto dura o necessário para o vídeo fechar em 15 s, com as fusões
  const DUR_FOTO = +((DURACAO + FUSAO * (n - 1)) / n).toFixed(3);
  const quadros = Math.round(DUR_FOTO * FPS);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const f of fotos) args.push('-loop', '1', '-t', String(DUR_FOTO), '-i', f);
  const partes = [];
  fotos.forEach((_, i) => {
    // cobre 1080x1920 com margem e faz aproximação lenta, alternando o sentido
    const zoom = i % 2 === 0 ? `min(1+0.0009*on,1.12)` : `max(1.12-0.0009*on,1)`;
    partes.push(
      `[${i}:v]scale=${W * 1.25}:${H * 1.25}:force_original_aspect_ratio=increase,crop=${W * 1.25}:${H * 1.25},` +
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${quadros}:s=${W}x${H}:fps=${FPS},` +
        `trim=duration=${DUR_FOTO},setpts=PTS-STARTPTS,format=yuv420p[f${i}]`
    );
  });
  let atual = 'f0';
  for (let i = 1; i < n; i++) {
    const offset = (DUR_FOTO - FUSAO) * i;
    partes.push(`[${atual}][f${i}]xfade=transition=fade:duration=${FUSAO}:offset=${offset.toFixed(2)}[x${i}]`);
    atual = `x${i}`;
  }
  const total = DUR_FOTO * n - FUSAO * (n - 1);
  const t = textos(item);
  const fimCartao = (total - 2.2).toFixed(2);
  const entra = (ini) => `alpha='if(lt(t,${ini}),0,min(1,(t-${ini})/0.6))'`;
  const legendaAte = `enable='lt(t,${fimCartao})'`;
  const txt = (texto, fonte, tam, y, extra = '') =>
    `drawtext=fontfile='${fonte}':text='${esc(texto)}':fontcolor=white:fontsize=${tam}:x=(w-text_w)/2:y=${y}${extra ? ':' + extra : ''}`;
  const overlay = [
    // véus para leitura
    `drawbox=x=0:y=0:w=iw:h=300:color=black@0.28:t=fill`,
    `drawbox=x=0:y=ih-820:w=iw:h=820:color=black@0.14:t=fill`,
    `drawbox=x=0:y=ih-760:w=iw:h=760:color=black@0.16:t=fill`,
    `drawbox=x=0:y=ih-700:w=iw:h=700:color=black@0.2:t=fill`,
    // identidade
    txt('M', FONTE_LEVE, 110, 70),
    txt(espacar('Mafuz'), FONTE_LEVE, 34, 196),
    // legenda do imóvel
    txt(t.local, FONTE, 32, 'h-690', `${entra(0.6)}:${legendaAte}`),
    txt(t.tipo, FONTE_LEVE, 58, 'h-620', `${entra(0.9)}:${legendaAte}`),
    txt(t.medidas, FONTE_LEVE, 40, 'h-520', `${entra(1.2)}:${legendaAte}`),
    txt(t.preco, FONTE, 64, 'h-430', `${entra(1.5)}:${legendaAte}`),
    txt(t.codigo, FONTE_LEVE, 30, 'h-330', `${entra(1.8)}:${legendaAte}`),
    // cartão final
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62:t=fill:enable='gte(t,${fimCartao})'`,
    txt('Agende sua visita', FONTE_LEVE, 72, '(h/2)-120', `enable='gte(t,${fimCartao})'`),
    txt('mafuz.site', FONTE, 44, '(h/2)+10', `enable='gte(t,${fimCartao})'`),
    txt('WhatsApp (31) 97537-7934', FONTE_LEVE, 38, '(h/2)+80', `enable='gte(t,${fimCartao})'`),
  ].join(',');
  partes.push(`[${atual}]${overlay},format=yuv420p[saida]`);
  args.push(
    '-filter_complex', partes.join(';'),
    '-map', '[saida]',
    '-t', total.toFixed(2),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an',
    saida
  );
  return { args, total };
}

class Videos {
  constructor(config, { imoview } = {}) {
    this.cfg = config.video;
    this.dir = path.join(config.dataDir, 'videos');
    this.imoview = imoview;
    this.fila = [];
    this.rodando = false;
    this.indice = {};
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.indice = JSON.parse(fs.readFileSync(path.join(this.dir, 'indice.json'), 'utf8'));
    } catch {
      this.indice = {};
    }
  }

  caminho(codigo) {
    return path.join(this.dir, `${String(codigo).replace(/\D/g, '')}.mp4`);
  }

  existe(codigo) {
    return fs.existsSync(this.caminho(codigo));
  }

  url(codigo) {
    return this.cfg.urlPublica && this.existe(codigo) ? `${this.cfg.urlPublica}/video/${codigo}.mp4` : null;
  }

  lista() {
    return Object.values(this.indice).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  }

  salvarIndice() {
    try {
      fs.writeFileSync(path.join(this.dir, 'indice.json'), JSON.stringify(this.indice, null, 1));
    } catch (e) {
      log('video_indice_erro', { erro: e.message });
    }
  }

  enfileirar(itens) {
    if (!this.cfg.ativo) return 0;
    let n = 0;
    for (const item of itens.slice(0, this.cfg.maxPorCiclo)) {
      if (this.existe(item.codigo) || this.fila.some((i) => i.codigo === item.codigo)) continue;
      this.fila.push(item);
      n += 1;
    }
    if (n) this.processar();
    return n;
  }

  async fotosDo(item) {
    let fotos = (item.fotos || []).slice(0, 5);
    if (fotos.length < 3 && this.imoview) {
      try {
        const bruto = await this.imoview.req('GET', '/Imovel/RetornarDetalhesImovelDisponivel', { query: { codigoImovel: item.codigo } });
        const i = bruto && (bruto.imovel || bruto);
        const mais = (Array.isArray(i && i.fotos) ? i.fotos : []).map((f) => (typeof f === 'string' ? f : f.url || f.urlm || f.urlp)).filter(Boolean);
        fotos = [...new Set([...fotos, ...mais])].slice(0, 5);
      } catch {
        /* segue com o que tem */
      }
    }
    return fotos;
  }

  async baixar(urls, pasta) {
    const locais = [];
    for (const [i, u] of urls.entries()) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 5000) continue;
        const arq = path.join(pasta, `f${i}.jpg`);
        fs.writeFileSync(arq, buf);
        locais.push(arq);
      } catch {
        /* foto indisponível */
      }
    }
    return locais;
  }

  rodarFfmpeg(args) {
    return new Promise((ok, falha) => {
      const p = spawn(this.cfg.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let erro = '';
      p.stderr.on('data', (d) => (erro += d.toString().slice(0, 2000)));
      p.on('error', falha);
      p.on('close', (c) => (c === 0 ? ok() : falha(new Error(erro.trim().slice(-400) || `ffmpeg saiu com ${c}`))));
    });
  }

  async gerar(item) {
    const pasta = fs.mkdtempSync(path.join(this.dir, 'tmp-'));
    try {
      let fotos = await this.baixar(await this.fotosDo(item), pasta);
      if (!fotos.length) throw new Error('imóvel sem fotos');
      while (fotos.length < 3) fotos = [...fotos, ...fotos].slice(0, 3);
      const destino = this.caminho(item.codigo);
      const temp = destino.replace(/\.mp4$/, '.tmp.mp4');
      const { args, total } = argumentosFfmpeg(fotos, item, temp);
      const t0 = Date.now();
      await this.rodarFfmpeg(args);
      fs.renameSync(temp, destino);
      this.indice[item.codigo] = {
        codigo: item.codigo,
        titulo: `${item.tipo || 'Imóvel'} · ${item.bairro || ''}`,
        preco: item.preco_formatado,
        segundos: +total.toFixed(1),
        criadoEm: new Date().toISOString(),
      };
      this.salvarIndice();
      log('video_gerado', { codigo: item.codigo, segundos_render: Math.round((Date.now() - t0) / 1000) });
      return destino;
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  }

  async processar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      while (this.fila.length) {
        const item = this.fila.shift();
        try {
          await this.gerar(item);
        } catch (e) {
          log('video_erro', { codigo: item.codigo, erro: e.message });
        }
      }
    } finally {
      this.rodando = false;
    }
  }
}

module.exports = { Videos, argumentosFfmpeg, textos };
