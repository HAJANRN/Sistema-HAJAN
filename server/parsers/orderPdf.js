import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';
import { orderIdOf } from './orderXlsx.js';

const HEAD_RE = /Pedido\s+HAJAN\s+(CXS|P[ÇC]S)\s+n[ºo°]?\s*(\d+)\s*-\s*(R\d+)\s+([A-Z]{2,5})/i;
const DATE_RE = /Natal,\s*(\d{2})\/(\d{2})\/(\d{2})/i;
const CLIENT_RE = /Cliente:\s*(.*?)\s*\((\d+)\)/i;
const BLOCK_HEAD_RE = /(\d+)\s+-\s+(R\d+)\s+([A-Z]{2,5})\s+-\s+(\d+)\s*[ªa]\s+entrega/i;
const CITY_RE = /Cidade:\s*(.*?)\s*-\s*([A-Z]{2})/i;
const WEIGHT_RE = /Peso\s+Total\s+\(kg\):\s*([\d.,]+)/gi;
const ITEM_RE = /(\d{6})\s*-\s*([^\d]+?)\s+([\d.]+)\s+kg\s+[\d.,]+/g;

const toNumber = (raw) => Number(String(raw).replace(/\./g, '').replace(',', '.')) || null;

export async function parseOrderPdf(file) {
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
  let text = '';
  try {
    text = String((await parser.getText()).text ?? '').replace(/\r/g, '');
  } finally {
    await parser.destroy();
  }

  const head = HEAD_RE.exec(text);
  if (!head) return { ok: false, reason: 'PDF fora do padrão do pedido HAJAN' };

  const type = /^cxs$/i.test(head[1]) ? 'CXS' : 'PCS';
  const id = orderIdOf({ type, number: Number(head[2]), revision: head[3], route: head[4] });

  const dateMatch = DATE_RE.exec(text);
  const clientMatch = CLIENT_RE.exec(text);

  const blocks = text.split(/^PEDIDO:\s*/m).slice(1);
  const deliveries = [];
  const bySeq = new Map();

  for (const block of blocks) {
    const blockHead = BLOCK_HEAD_RE.exec(block.split('\n')[0] ?? '');
    if (!blockHead) continue;
    const seq = Number(blockHead[4]);
    const cityMatch = CITY_RE.exec(block);
    const flat = block.replace(/\n/g, ' ');

    const weights = [...flat.matchAll(WEIGHT_RE)]
      .map((m) => toNumber(m[1]))
      .filter((n) => n != null);
    const items = [...flat.matchAll(ITEM_RE)].map((m) => ({
      code: m[1],
      name: m[2].replace(/\s{2,}/g, ' ').trim(),
      kg: toNumber(m[3]),
    }));

    const delivery = {
      seq,
      city: cityMatch?.[1]?.trim() ?? '',
      uf: cityMatch?.[2] ?? '',
      weightKg: weights.length === 1 ? weights[0] : null,
      items,
    };

    if (bySeq.has(seq)) {
      const previous = bySeq.get(seq);
      previous.weightKg = previous.weightKg ?? delivery.weightKg;
      previous.items = previous.items.concat(delivery.items);
      continue;
    }
    bySeq.set(seq, delivery);
    deliveries.push(delivery);
  }

  if (!deliveries.length) return { ok: false, reason: 'nenhuma entrega encontrada no PDF' };

  const allWeights = [...text.replace(/\n/g, ' ').matchAll(WEIGHT_RE)]
    .map((m) => toNumber(m[1]))
    .filter((n) => n != null);

  return {
    ok: true,
    id,
    type,
    number: Number(head[2]),
    revision: head[3].toUpperCase(),
    route: head[4].toUpperCase(),
    issueDate: dateMatch ? `20${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null,
    client: clientMatch?.[1]?.replace(/\s{2,}/g, ' ').trim() ?? null,
    totalKg: allWeights.length ? allWeights.reduce((sum, n) => sum + n, 0) : null,
    deliveries,
    sourceFile: file,
  };
}
