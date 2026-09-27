'use strict';

const TZ = 'America/Sao_Paulo';
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function log(evento, dados = {}) {
  const linha = { ts: new Date().toISOString(), evento, ...dados };
  try {
    console.log(JSON.stringify(linha));
  } catch {
    console.log(evento);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseValorBR(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^\d,]/g, '');
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseNumBR(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function formatarBRL(n) {
  if (!n) return 'Sob consulta';
  return 'R$ ' + Math.round(n).toLocaleString('pt-BR');
}

// ---------- tempo em America/Sao_Paulo ----------
function partesSP(data = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(data).map((x) => [x.type, x.value]));
  const mapaDia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hora = Number(p.hour) % 24;
  const minuto = Number(p.minute);
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora,
    minuto,
    diaSemana: mapaDia[p.weekday],
    iso: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${String(hora).padStart(2, '0')}:${p.minute}`,
    minutosDoDia: hora * 60 + minuto,
  };
}

function textoAgora(data = new Date()) {
  const p = partesSP(data);
  return `${DIAS[p.diaSemana]}, ${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}/${p.ano}, ${p.hhmm} (horário de Brasília)`;
}

function saudacao(data = new Date()) {
  const h = partesSP(data).hora;
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function dentroDoHorario(regras, data = new Date()) {
  const p = partesSP(data);
  const r = regras[p.diaSemana];
  return !!r && p.minutosDoDia >= r.abre && p.minutosDoDia < r.fecha;
}

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Próximos dias com janela de visita (hoje entra se ainda houver 2h úteis).
function proximosDiasVisita(regras, quantidade = 6, data = new Date()) {
  const hoje = partesSP(data);
  const base = Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia, 12);
  const dias = [];
  for (let i = 0; i < 21 && dias.length < quantidade; i++) {
    const d = new Date(base + i * 86400000);
    const ds = d.getUTCDay();
    const r = regras[ds];
    if (!r) continue;
    let abre = r.abre;
    if (i === 0) {
      const minimo = Math.ceil((hoje.minutosDoDia + 120) / 60) * 60;
      if (minimo >= r.fecha) continue;
      abre = Math.max(abre, minimo);
    }
    const iso = d.toISOString().slice(0, 10);
    dias.push({
      data: iso,
      rotulo: `${i === 0 ? 'hoje, ' : i === 1 ? 'amanhã, ' : ''}${DIAS[ds]} (${iso.slice(8, 10)}/${iso.slice(5, 7)})`,
      janela: `${hm(abre)} às ${hm(r.fecha)}`,
      abre,
      fecha: r.fecha,
    });
  }
  return dias;
}

function validarHorarioVisita(regras, dataISO, hora, agora = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataISO || '')) return 'data em formato inválido (use AAAA-MM-DD)';
  if (!/^\d{1,2}:\d{2}$/.test(hora || '')) return 'hora em formato inválido (use HH:mm)';
  const [hh, mm] = hora.split(':').map(Number);
  const minutos = hh * 60 + mm;
  const d = new Date(`${dataISO}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'data inválida';
  const r = regras[d.getUTCDay()];
  if (!r) return `não há visitas em ${DIAS[d.getUTCDay()]}`;
  if (minutos < r.abre || minutos > r.fecha - 30) return `fora da janela de visitas (${hm(r.abre)} às ${hm(r.fecha)})`;
  const hoje = partesSP(agora);
  if (dataISO < hoje.iso) return 'data já passou';
  if (dataISO === hoje.iso && minutos < hoje.minutosDoDia + 90) return 'horário muito próximo; ofereça outro';
  return null;
}

function rotuloData(dataISO) {
  const d = new Date(`${dataISO}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]}, ${dataISO.slice(8, 10)}/${dataISO.slice(5, 7)}`;
}

// ---------- telefones ----------
const digitos = (s) => String(s || '').replace(/\D/g, '');
function foneNacional(fone) {
  const d = digitos(fone);
  return d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
}
function foneExibicao(fone) {
  const n = foneNacional(fone);
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return fone;
}

function limparTitulo(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Títulos do CRM costumam vir em caixa alta: normaliza para frase.
  if (s === s.toUpperCase()) return s.charAt(0) + s.slice(1).toLowerCase();
  return s;
}

module.exports = {
  log,
  sleep,
  norm,
  parseValorBR,
  parseNumBR,
  formatarBRL,
  partesSP,
  textoAgora,
  saudacao,
  dentroDoHorario,
  proximosDiasVisita,
  validarHorarioVisita,
  rotuloData,
  digitos,
  foneNacional,
  foneExibicao,
  limparTitulo,
  DIAS,
};
