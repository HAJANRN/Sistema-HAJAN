import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { ANEXO_ROOT, SPOOL_DIR } from './config.js';
import {
  addAttachment,
  getAttachment,
  getOrder,
  pendingAttachments,
  setAttachmentLocation,
  summaryAttachment,
} from './store.js';
import { REFUSAL_LABELS } from './reasons.js';

/** A gravação no S: não foi possível agora (rede fora do ar) — o arquivo fica na fila local. */
export class FolderUnavailable extends Error {}

const pad = (value) => String(value).padStart(2, '0');

/** Semana ISO 8601 (segunda a domingo), a mesma numeração usada no painel. */
export function isoWeek(iso) {
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const thursday = date.getTime();
  date.setMonth(0, 1);
  return {
    week: Math.round((thursday - date.getTime()) / 604_800_000) + 1,
    year: date.getFullYear(),
  };
}

const ACCENTS = new RegExp('[\\u0300-\\u036f]', 'g');
const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');

const normalize = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(ACCENTS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Tira o que o Windows não aceita em nome de arquivo ou de pasta. */
function cleanName(value, max) {
  const cleaned = String(value ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, max);
  return cleaned || 'arquivo';
}

/** Nome vindo do navegador: guarda só o nome do arquivo, sem caminho e sem caracteres proibidos. */
export function safeFileName(value) {
  const base = path.basename(String(value ?? '').replace(/\\/g, '/'));
  const cleaned = cleanName(base, 120);
  return cleaned === 'arquivo' ? null : cleaned;
}

const listDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** Data que decide a semana do arquivo: agendamento, entrega, embarque ou a data do registro. */
function referenceDate(order, delivery) {
  return (
    delivery.scheduledAt ??
    delivery.statusAt?.slice(0, 10) ??
    order.deliveryDate ??
    order.shipDate ??
    new Date().toISOString().slice(0, 10)
  );
}

function typeLabel(order) {
  return order.type === 'PCS' ? 'PÇS' : 'CXS';
}

function deliveryFolderName(order, delivery) {
  return cleanName(
    `Pedido ${typeLabel(order)} ${order.number} ${order.route} - ${delivery.name}`,
    110,
  );
}

/** Reaproveita a pasta da semana já existente, inclusive quando tem sufixo ("- OK", "- 02 Anomalias"). */
function resolveWeekDir(year, week, create) {
  const base = path.join(ANEXO_ROOT, String(year));
  const wanted = normalize(`semana ${week}`);
  const existing = listDirs(base).find((name) => {
    const match = normalize(name).match(/^semana\s*(\d{1,3})\b/);
    return match && normalize(`semana ${Number(match[1])}`) === wanted;
  });
  if (existing) return path.join(base, existing);
  const target = path.join(base, `Semana ${pad(week)}`);
  if (!create) return null;
  if (!isDirectory(ANEXO_ROOT)) throw new FolderUnavailable(`${ANEXO_ROOT} não está acessível`);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    throw new FolderUnavailable(`não foi possível criar ${target}: ${error.code ?? error.message}`);
  }
  return target;
}

/** Procura a pasta do cliente que já existe para esta entrega, antes de criar uma nova. */
function resolveDeliveryDir(weekDir, order, delivery) {
  const clientTokens = normalize(delivery.name)
    .split(' ')
    .filter((word) => word.length > 2);
  const existing = listDirs(weekDir).find((name) => {
    const tokens = normalize(name).split(' ');
    if (!tokens.includes(String(order.number))) return false;
    if (!clientTokens.length) return true;
    return clientTokens.every((token) => tokens.includes(token));
  });
  if (existing) return path.join(weekDir, existing);
  const target = path.join(weekDir, deliveryFolderName(order, delivery));
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    throw new FolderUnavailable(`não foi possível criar ${target}: ${error.code ?? error.message}`);
  }
  return target;
}

function targetDir(order, delivery) {
  const week = isoWeek(referenceDate(order, delivery));
  if (!week) throw new FolderUnavailable('sem data válida para definir a semana');
  const weekDir = resolveWeekDir(week.year, week.week, true);
  return { dir: resolveDeliveryDir(weekDir, order, delivery), week };
}

/** Nunca sobrescreve: se o nome já existe, acrescenta (2), (3)… */
function uniqueIn(dir, fileName, ownPath) {
  if (ownPath && path.dirname(ownPath) === dir && fs.existsSync(ownPath)) return ownPath;
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let index = 1; index <= 60; index += 1) {
    const candidate = path.join(dir, index === 1 ? `${stem}${ext}` : `${stem} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new FolderUnavailable(`muitos arquivos com o mesmo nome em ${dir}`);
}

const spoolPath = (id, fileName) => path.join(SPOOL_DIR, `${id}-${cleanName(fileName, 60)}`);

function writeSpool(id, fileName, buffer) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true });
  const target = spoolPath(id, fileName);
  fs.writeFileSync(target, buffer);
  return target;
}

function place(buffer, fileName, order, delivery) {
  const { dir } = targetDir(order, delivery);
  const target = uniqueIn(dir, cleanName(fileName, 120));
  fs.writeFileSync(target, buffer);
  return target;
}

/** Caminho absoluto de onde o arquivo está agora (no S: ou na fila deste computador). */
export function storedPath(attachment) {
  if (!attachment?.path) return null;
  return fs.existsSync(attachment.path) ? attachment.path : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_EMBED_BYTES = 12 * 1024 * 1024;
const MAX_EMBED_PIXELS = 24_000_000;

/**
 * pdfkit desenha PNG num callback assíncrono do zlib: um IDAT corrompido ou um
 * IHDR com dimensões absurdas gera exceção fora do try/catch e derruba o servidor
 * para todo o escritório. Só entram no PDF imagens verificadas aqui, de forma síncrona.
 */
function isPng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const interlace = buffer[28];
  if (!width || !height || width * height > MAX_EMBED_PIXELS) return false;
  if (interlace !== 0) return false;

  const idat = [];
  let pos = 8;
  while (pos + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    if (start + size + 4 > buffer.length) return false;
    if (type === 'IDAT') idat.push(buffer.subarray(start, start + size));
    if (type === 'IEND') break;
    pos = start + size + 4;
  }
  if (!idat.length) return false;
  try {
    zlib.inflateSync(Buffer.concat(idat));
    return true;
  } catch {
    return false;
  }
}

function isJpeg(buffer) {
  return buffer.length > 400 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

/** Caminho da imagem embutível, ou null quando o arquivo não deve ir para o PDF. */
function embeddableImage(item) {
  const file = storedPath(item);
  if (!file || !/image\/(jpeg|png)/i.test(item.mime ?? '')) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_EMBED_BYTES) return null;
  const ok = PNG_SIGNATURE.equals(buffer.subarray(0, 8)) ? isPng(buffer) : isJpeg(buffer);
  return ok ? file : null;
}

export function storeAttachment({ order, seq, delivery, name, mime, buffer }) {
  const id = randomUUID();
  addAttachment({
    id,
    orderId: order.id,
    seq,
    name,
    mime,
    bytes: buffer.length,
    kind: 'arquivo',
    status: 'fila',
  });
  try {
    const target = place(buffer, name, order, delivery);
    setAttachmentLocation(id, {
      status: 'no_s',
      path: target,
      name: path.basename(target),
    });
  } catch (error) {
    if (!(error instanceof FolderUnavailable)) {
      setAttachmentLocation(id, { status: 'erro', path: null });
      throw error;
    }
    const queued = writeSpool(id, name, buffer);
    setAttachmentLocation(id, { status: 'fila', path: queued });
  }
  return getAttachment(id);
}

const fmtDate = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : String(iso);
};

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const fmtKg = (value) =>
  value == null ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`;

function line(doc, label, value) {
  doc
    .fontSize(10)
    .fillColor('#444444')
    .text(label, { continued: true })
    .fillColor('#000000')
    .text(`  ${value}`);
}

function drawPhotos(doc, photos) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const photo of photos) {
    try {
      if (doc.y > doc.page.height - 260) doc.addPage();
      doc.moveDown(0.6);
      doc.image(photo.path, { width: Math.min(width, 430) });
    } catch {
      doc.fontSize(9).fillColor('#888888').text(`(não foi possível embutir ${photo.name})`);
    }
  }
}
/** Monta o PDF de resumo da anomalia e devolve o registro (no S: ou na fila). */
export function writeSummary(order, delivery, attachments = []) {
  const files = attachments.filter((item) => item.kind === 'arquivo');
  const photos = files
    .map((item) => ({ name: item.name, path: embeddableImage(item) }))
    .filter((item) => item.path)
    .slice(0, 10);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    info: { Title: `Anomalia pedido ${order.number}` },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', resolve));

  doc.fontSize(16).fillColor('#000000').text('Registro de anomalia', { continued: true });
  doc.fontSize(10).fillColor('#666666').text('  HAJAN · Expedição de carne');
  doc.moveDown(0.4);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#cccccc')
    .stroke();
  doc.moveDown(0.8);

  line(
    doc,
    'Pedido',
    `${typeLabel(order)} ${order.number} rev ${order.revision} · rota ${order.route}`,
  );
  line(doc, 'Embarque', fmtDate(order.shipDate));
  line(
    doc,
    'Entrega',
    `${fmtDate(order.deliveryDate)}${delivery.scheduledAt ? ` · agendada ${fmtDate(delivery.scheduledAt)}` : ''}`,
  );
  line(
    doc,
    'Cliente',
    `${delivery.name} — ${delivery.city ?? ''}${delivery.uf ? `/${delivery.uf}` : ''}`,
  );
  line(doc, 'Entrega', `${delivery.seq} de ${order.deliveries.length}`);
  line(doc, 'Peso', fmtKg(delivery.weightKg));
  doc.moveDown(0.5);

  doc
    .fontSize(12)
    .fillColor('#7d1f16')
    .text(REFUSAL_LABELS[delivery.reason] ?? 'Anomalia sem motivo marcado');
  doc.moveDown(0.3);
  doc
    .fontSize(10)
    .fillColor('#000000')
    .text(delivery.note ? delivery.note : 'Sem observação registrada.');
  doc.moveDown(0.4);

  const resale =
    delivery.resale === true
      ? `Sim${delivery.resaleDate ? `, prevista para ${fmtDate(delivery.resaleDate)}` : ''}`
      : delivery.resale === false
        ? 'Não'
        : 'Não informada';
  line(doc, 'Revenda', resale);
  line(doc, 'Registrado', fmtDateTime(delivery.statusAt ?? new Date().toISOString()));

  if (files.length) {
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#444444').text(`Arquivos nesta pasta (${files.length}):`);
    doc.fontSize(9).fillColor('#000000');
    for (const file of files) doc.text(`• ${file.name} · ${Math.round(file.bytes / 1024)} KB`);
  }

  if (photos.length) {
    doc.moveDown(0.6);
    doc.fontSize(10).fillColor('#444444').text('Fotos:');
    drawPhotos(doc, photos);
  }

  let folder = null;
  try {
    folder = targetDir(order, delivery).dir;
  } catch {
    // pasta de relatórios fora do ar: o PDF nasce na fila local e ganha o caminho quando for enviado
  }
  doc.moveDown(0.8);
  doc
    .fontSize(8)
    .fillColor('#888888')
    .text(
      folder
        ? `Pasta: ${folder}`
        : 'Pasta de relatórios indisponível no momento — o arquivo será enviado quando a rede voltar.',
    );

  doc.end();
  return done.then(() => finish(order, delivery, Buffer.concat(chunks)));
}

/** Nome do arquivo de resumo da anomalia. */
function summaryFileName(order, delivery) {
  const reason = normalize(REFUSAL_LABELS[delivery.reason] ?? 'anomalia').replace(/ /g, '_');
  return cleanName(
    `Resumo anomalia ${typeLabel(order)} ${order.number} ${order.route} - ${reason}.pdf`,
    120,
  );
}

function finish(order, delivery, buffer) {
  const previous = summaryAttachment(order.id, delivery.seq);
  const id = previous?.id ?? randomUUID();
  const fileName = summaryFileName(order, delivery);
  if (!previous) {
    addAttachment({
      id,
      orderId: order.id,
      seq: delivery.seq,
      name: fileName,
      mime: 'application/pdf',
      bytes: buffer.length,
      kind: 'resumo',
      status: 'fila',
    });
  }
  try {
    const { dir } = targetDir(order, delivery);
    const own =
      previous?.path && path.basename(previous.path) === fileName ? previous.path : undefined;
    const target = uniqueIn(dir, fileName, own);
    fs.writeFileSync(target, buffer);
    // o nome acompanha o motivo: se mudou, o resumo antigo (nosso) sai de cena para não deixar etiqueta errada na pasta
    if (previous?.path && previous.path !== target) fs.rmSync(previous.path, { force: true });
    setAttachmentLocation(id, {
      status: 'no_s',
      path: target,
      bytes: buffer.length,
      name: fileName,
    });
  } catch (error) {
    if (!(error instanceof FolderUnavailable)) throw error;
    const queued = writeSpool(id, fileName, buffer);
    if (previous?.path && previous.status === 'fila' && previous.path !== queued)
      fs.rmSync(previous.path, { force: true });
    setAttachmentLocation(id, {
      status: 'fila',
      path: queued,
      bytes: buffer.length,
      name: fileName,
    });
  }
  return getAttachment(id);
}

/** Tira da fila local tudo o que o S: ainda não recebeu. */
export function flushQueue() {
  let moved = 0;
  let pending = 0;
  for (const item of pendingAttachments()) {
    const order = getOrder(item.orderId);
    const delivery = order?.deliveries.find((row) => row.seq === item.seq);
    const source = storedPath(item);
    if (!order || !delivery || !source) {
      pending += 1;
      continue;
    }
    try {
      const { dir } = targetDir(order, delivery);
      const target = uniqueIn(dir, cleanName(item.name, 120));
      fs.copyFileSync(source, target);
      fs.rmSync(source, { force: true });
      setAttachmentLocation(item.id, {
        status: 'no_s',
        path: target,
        name: path.basename(target),
      });
      moved += 1;
    } catch (error) {
      if (!(error instanceof FolderUnavailable)) throw error;
      pending += 1;
    }
  }
  return { moved, pending };
}

export function attachmentRoot() {
  return ANEXO_ROOT;
}
