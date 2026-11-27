import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  DIST_DIR,
  HOST,
  PORT,
  ROOT,
  lanUrl,
  tunnelUrl,
  ANEXO_MAX_BYTES,
  VISITA_TOKEN,
} from './config.js';
import {
  bloqueado,
  conferirCredenciais,
  decidir,
  definirSenha,
  headerCookieAcesso,
  headerCookieAdmin,
  headerCookieSair,
  limparFaltas,
  papel,
  registrarFalta,
  senhaDefinida,
  tokenOk,
  usuarioOk,
} from './acesso.js';
import { router as emissorRouter } from './emissor.js';
import { router as emissorPedidosRouter } from './emissorPedidos.js';
import { getScanState, scanAll, startWatch } from './importer.js';
import { getBillingState, startBillingWatch, syncBilling } from './billing.js';
import {
  FolderUnavailable,
  attachmentRoot,
  flushQueue,
  folderFor,
  removeAttachment,
  removeMissingAttachments,
  safeFileName,
  storeAttachment,
  storedPath,
  writeSummary,
} from './attachments.js';
import { withEstimates } from './estimates.js';
import { fillMissingDistances } from './routing.js';
import {
  REFUSAL_REASONS,
  STATUSES,
  STATUSES_ACEITOS,
  distanceStats,
  getAttachment,
  getEtaSettings,
  getOrder,
  initStore,
  lastErrors,
  listOrders,
  refreshAutoFields,
  revisionNow,
  setEtaSettings,
  summary,
  updateDelivery,
  updateOrderFields,
} from './store.js';

async function alreadyRunning() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.app === 'expedicao-carnes';
  } catch {
    return false;
  }
}

const reinicio = process.argv.includes('--reinicio');

async function aguardarPortaLivre() {
  for (let tentativa = 0; tentativa < 20; tentativa += 1) {
    if (!(await alreadyRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

if (!reinicio && (await alreadyRunning())) {
  console.log(`O programa já está aberto em http://localhost:${PORT}`);
  if (process.argv.includes('--open')) {
    exec(`start "" http://localhost:${PORT}`);
  }
  process.exit(0);
}

if (reinicio) await aguardarPortaLivre();

try {
  initStore();
} catch (error) {
  if (String(error?.message).includes('database is locked')) {
    console.error('O programa já está aberto em outra janela. Feche a outra e abra novamente.');
  } else {
    console.error('Não consegui abrir o banco de dados:');
    console.error(error);
  }
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'expedicao-carnes' }));

/** Quem está fora da rede chega por aqui com o token; recebe um cookie assinado e passa a trabalhar. */
app.get('/api/visita', (req, res) => {
  if (!tokenOk(req.query.token))
    return res.status(403).json({ error: 'link inválido ou expirado' });
  res.set('Set-Cookie', headerCookieAcesso());
  res.redirect('/');
});

/** Rotas que mexem com a origem dos dados ou com o servidor: só com a senha do escritório. */
const ROTAS_ADMIN = new Set([
  '/settings',
  '/rescan',
  '/attachments/flush',
  '/senha',
  '/servidor/reiniciar',
]);

app.use('/api', (req, res, next) => {
  if (req.path === '/visita') return next();
  const decisao = decidir(req);
  if (decisao === 'negar') {
    return res.status(403).json({
      error: 'link de acompanhamento expirado — peça um novo ao escritório',
    });
  }
  const rotasPublicas = new Set(['/health', '/sessao', '/entrada', '/saida']);
  if (!rotasPublicas.has(req.path)) {
    if (!senhaDefinida() && req.path === '/senha' && req.method === 'POST') return next();
    if (!senhaDefinida() || decisao !== 'administracao') {
      return res.status(401).json({ error: 'entre com usuário e senha para acessar o sistema' });
    }
  }
  const escreve = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (escreve && ROTAS_ADMIN.has(req.path) && decisao !== 'administracao') {
    return res.status(403).json({ error: 'digite a senha do escritório para mexer aqui' });
  }
  return next();
});

app.get('/api/sessao', (req, res) =>
  res.json({ role: papel(req), senhaDefinida: senhaDefinida(), revision: revisionNow() }),
);

/** Login da área administrativa: acerta a senha e recebe um cookie válido por ADMIN_HORAS. */
app.post('/api/entrada', (req, res) => {
  const ip = req.socket.remoteAddress ?? 'desconhecido';
  if (bloqueado(ip)) {
    return res.status(429).json({ error: 'muitas tentativas — espere 15 minutos' });
  }
  if (!conferirCredenciais(req.body?.usuario, req.body?.senha)) {
    registrarFalta(ip);
    return res.status(403).json({ error: 'usuário ou senha incorretos' });
  }
  limparFaltas(ip);
  res.set('Set-Cookie', headerCookieAdmin());
  res.json({ role: 'administracao' });
});

app.post('/api/saida', (req, res) => {
  res.set('Set-Cookie', headerCookieSair());
  res.json({ role: 'operacao' });
});

/** Emissor de pedidos: consulta das tabelas emissor_* do banco unificado. */
app.use('/api/emissor', emissorRouter);

/** Digitação de pedidos: base, carteira, clones, emissão e download do PDF (rotas novas, sem prefixo próprio). */
app.use('/api/emissor', emissorPedidosRouter);

/** Primeira vez define; depois disso só quem já está dentro troca a senha. */
app.post('/api/senha', (req, res) => {
  if (!senhaDefinida() && !usuarioOk(req.body?.usuario)) {
    return res.status(403).json({ error: 'usuário incorreto' });
  }
  try {
    definirSenha(req.body?.senha);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.set('Set-Cookie', headerCookieAdmin());
  res.json({ role: 'administracao' });
});

const MARCA_REINICIO = path.join(ROOT, 'data', 'reiniciar');

app.post('/api/servidor/reiniciar', (req, res) => {
  res.json({ reiniciando: true });
  // Aberto pelo servidor.cmd: ele refaz o start na hora e continua de vigilante.
  if (process.env.FRIBOI_SUPERVISOR) {
    try {
      fs.writeFileSync(MARCA_REINICIO, '');
    } catch {}
    return setTimeout(() => process.exit(9), 200);
  }
  const filho = spawn(process.execPath, [process.argv[1], '--reinicio'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  filho.unref();
  setTimeout(() => process.exit(0), 200);
});

app.get('/api/status', (req, res) => {
  res.json({
    lan: lanUrl(),
    tunnel: tunnelUrl(),
    role: papel(req),
    attachmentRoot: attachmentRoot(),
    attachmentMaxBytes: ANEXO_MAX_BYTES,
    ...getScanState(),
    billing: getBillingState(),
    ...summary(),
    ...distanceStats(),
    errors: lastErrors(),
  });
});

app.get('/api/settings', (req, res) => res.json(getEtaSettings()));

app.put('/api/settings', (req, res) => {
  const speedKmh = Number(req.body?.speedKmh);
  const stopMinutes = Number(req.body?.stopMinutes);
  if (!Number.isFinite(speedKmh) || speedKmh < 20 || speedKmh > 120) {
    return res.status(400).json({ error: 'velocidade média deve ficar entre 20 e 120 km/h' });
  }
  if (!Number.isFinite(stopMinutes) || stopMinutes < 0 || stopMinutes > 480) {
    return res.status(400).json({ error: 'tempo de descarga deve ficar entre 0 e 480 minutos' });
  }
  res.json(
    setEtaSettings({
      speedKmh: Math.round(speedKmh),
      stopMinutes: Math.round(stopMinutes),
    }),
  );
});

app.get('/api/orders', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !iso.test(from)) || (to && !iso.test(to))) {
    return res.status(400).json({ error: 'datas devem usar o formato AAAA-MM-DD' });
  }
  // arquivo apagado na pasta some da lista junto (no máximo uma conferência por minuto)
  removeMissingAttachments();
  // O conteúdo não mudou desde a última sincronização: evita serializar tudo de novo.
  // O app só manda a revisão quando está pedindo a mesma janela de datas que já tem.
  const known = Number(req.query.revision);
  if (Number.isFinite(known) && known === revisionNow()) {
    return res.json({ revision: known, unchanged: true });
  }
  const settings = getEtaSettings();
  res.json({
    revision: revisionNow(),
    orders: listOrders({ from, to }).map((order) => withEstimates(order, settings)),
  });
});

app.get('/api/orders/:id', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
  res.json(withEstimates(order));
});

/** Placas e instrução filial: digitadas no acompanhamento, sem senha, como o status da entrega. */
app.patch('/api/orders/:id', (req, res) => {
  const { plates, branchInstruction } = req.body ?? {};
  const optionalText = (value, max) =>
    value === null || (typeof value === 'string' && value.length <= max);

  if (plates !== undefined && !optionalText(plates, 80)) {
    return res.status(400).json({ error: 'placas inválidas (até 80 caracteres)' });
  }
  if (branchInstruction !== undefined && !optionalText(branchInstruction, 500)) {
    return res.status(400).json({ error: 'instrução filial inválida (até 500 caracteres)' });
  }
  if (plates === undefined && branchInstruction === undefined) {
    return res.status(400).json({ error: 'nenhuma alteração informada' });
  }

  const updated = updateOrderFields(req.params.id, { plates, branchInstruction });
  if (!updated) return res.status(404).json({ error: 'pedido não encontrado' });
  res.json(updated);
});

app.patch('/api/orders/:id/deliveries/:seq', async (req, res) => {
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq)) return res.status(400).json({ error: 'seq inválido' });

  const { status, note, observation, scheduledAt, reason, resale, resaleDate, lombador } =
    req.body ?? {};
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const optionalDate = (value) => value === null || (typeof value === 'string' && iso.test(value));

  if (status !== undefined && !STATUSES_ACEITOS.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${STATUSES.join(', ')}` });
  }
  if (note != null && (typeof note !== 'string' || note.length > 500)) {
    return res.status(400).json({ error: 'observação inválida' });
  }
  if (observation != null && (typeof observation !== 'string' || observation.length > 500)) {
    return res.status(400).json({ error: 'observação da entrega inválida' });
  }
  if (scheduledAt !== undefined && !optionalDate(scheduledAt)) {
    return res.status(400).json({ error: 'data do agendamento deve usar AAAA-MM-DD' });
  }
  if (reason !== undefined && reason !== null && !REFUSAL_REASONS.includes(reason)) {
    return res.status(400).json({ error: `motivo deve ser um de: ${REFUSAL_REASONS.join(', ')}` });
  }
  if (resale !== undefined && resale !== null && typeof resale !== 'boolean') {
    return res.status(400).json({ error: 'revenda deve ser sim ou não' });
  }
  if (resaleDate !== undefined && !optionalDate(resaleDate)) {
    return res.status(400).json({ error: 'data da revenda deve usar AAAA-MM-DD' });
  }
  if (lombador !== undefined && lombador !== null && typeof lombador !== 'boolean') {
    return res.status(400).json({ error: 'lombador deve ser sim ou não' });
  }
  if (
    [status, note, observation, scheduledAt, reason, resale, resaleDate, lombador].every(
      (value) => value === undefined,
    )
  ) {
    return res.status(400).json({ error: 'nenhuma alteração informada' });
  }

  const updated = updateDelivery(req.params.id, seq, {
    status,
    note,
    observation,
    scheduledAt,
    reason,
    resale,
    resaleDate,
    lombador,
  });
  if (!updated) return res.status(404).json({ error: 'entrega não encontrada' });

  if (updated.status === 'recusado' || updated.reason) {
    const order = getOrder(req.params.id);
    const delivery = order.deliveries.find((row) => row.seq === seq);
    const summary = await writeSummary(order, delivery, delivery.attachments);
    return res.json({ ...updated, summary });
  }

  res.json(updated);
});

app.post(
  '/api/orders/:id/deliveries/:seq/attachments',
  express.raw({ type: () => true, limit: ANEXO_MAX_BYTES }),
  async (req, res) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'seq inválido' });

    const order = getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
    const delivery = order.deliveries.find((row) => row.seq === seq);
    if (!delivery) return res.status(404).json({ error: 'entrega não encontrada' });

    const name = safeFileName(req.query.name ?? req.get('x-file-name'));
    if (!name) return res.status(400).json({ error: 'nome de arquivo inválido' });

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ error: 'arquivo vazio' });

    const mime = String(req.get('content-type') ?? 'application/octet-stream').split(';')[0];
    const attachment = storeAttachment({
      order,
      seq,
      delivery,
      name,
      mime,
      buffer,
    });
    // relê para o resumo já sair com o arquivo recém-recebido na lista
    const fresh = getOrder(req.params.id);
    const updated = fresh.deliveries.find((row) => row.seq === seq);
    const summary = await writeSummary(fresh, updated, updated.attachments);
    res.status(201).json({ attachment, summary });
  },
);

app.get('/api/attachments/:id/raw', (req, res) => {
  const item = getAttachment(req.params.id);
  if (!item) return res.status(404).json({ error: 'anexo não encontrado' });
  const file = storedPath(item);
  if (!file)
    return res.status(409).json({ error: 'o arquivo ainda não chegou na pasta de relatórios' });
  res.set('Content-Type', item.mime ?? 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
  fs.createReadStream(file).pipe(res);
});

app.delete('/api/attachments/:id', async (req, res) => {
  const item = getAttachment(req.params.id);
  if (!item) return res.status(404).json({ error: 'anexo não encontrado' });
  if (item.kind === 'resumo')
    return res.status(400).json({ error: 'o resumo da anomalia é gerado automaticamente' });

  const removed = removeAttachment(item.id);
  if (!removed) return res.status(404).json({ error: 'anexo não encontrado' });

  const order = getOrder(item.orderId);
  const delivery = order?.deliveries.find((row) => row.seq === item.seq);
  if (order && delivery?.reason) {
    const summary = await writeSummary(order, delivery, delivery.attachments);
    return res.json({ removed: true, summary });
  }
  res.json({ removed: true });
});

app.post('/api/orders/:id/deliveries/:seq/anomalia/salvar', async (req, res) => {
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq)) return res.status(400).json({ error: 'seq inválido' });

  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
  const delivery = order.deliveries.find((row) => row.seq === seq);
  if (!delivery) return res.status(404).json({ error: 'entrega não encontrada' });
  if (!delivery.reason)
    return res.status(400).json({ error: 'marque o motivo da anomalia antes de salvar' });

  try {
    flushQueue();
  } catch (error) {
    if (!(error instanceof FolderUnavailable)) throw error;
  }

  const fresh = getOrder(req.params.id);
  const atual = fresh.deliveries.find((row) => row.seq === seq);
  const summary = await writeSummary(fresh, atual, atual.attachments);
  const arquivos = atual.attachments.filter((item) => item.kind === 'arquivo');
  res.json({
    id: summary.id,
    folder:
      summary.status === 'no_s' && summary.path
        ? path.dirname(summary.path)
        : folderFor(fresh, atual),
    saved: arquivos.filter((item) => item.status === 'no_s').length,
    pending: arquivos.filter((item) => item.status !== 'no_s').length,
    summary,
  });
});

app.post('/api/attachments/flush', (req, res) => {
  try {
    res.json(flushQueue());
  } catch (error) {
    if (error instanceof FolderUnavailable)
      return res.json({ moved: 0, pending: 0, error: error.message });
    throw error;
  }
});

app.post('/api/rescan', (req, res) => {
  res.json({ started: true });
  setTimeout(() => {
    runScan(req.query.force === '1').catch((error) =>
      console.error('rescan falhou:', error.message),
    );
  }, 10);
});

async function runScan(force = false) {
  const result = await scanAll({ force });
  try {
    const queue = flushQueue();
    if (queue.moved || queue.pending)
      console.log(`Anexos: ${queue.moved} enviados para a pasta, ${queue.pending} na fila`);
  } catch (error) {
    console.error('fila de anexos:', error.message);
  }
  try {
    // arquivo apagado direto na pasta da rede também sai da lista do pedido
    const reconcil = removeMissingAttachments();
    if (reconcil.removed) console.log(`Anexos: ${reconcil.removed} apagados da pasta saíram do sistema`);
  } catch (error) {
    console.error('conferência de anexos:', error.message);
  }
  try {
    // pedido novo pode completar o faturamento que já estava na pasta
    const billing = await syncBilling({ force: force || result.lastScan.imported > 0 });
    if (billing.lastSync.orders)
      console.log(
        `Faturamento: ${billing.lastSync.orders} pedidos com dados do ERP (${billing.lastSync.unmatchedRows} linhas sem pedido)`,
      );
    // recalcula placas/instrução filial também quando o código muda, sem reimportar o ERP
    refreshAutoFields();
  } catch (error) {
    console.error('faturamento:', error.message);
  }
  startBillingWatch();
  fillMissingDistances().catch((error) => console.error('rotas falharam:', error.message));
  return result;
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `arquivo maior que ${Math.round(ANEXO_MAX_BYTES / 1_048_576)} MB`,
    });
  }
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'requisição inválida' });
  }
  console.error(error);
  res.status(500).json({ error: 'erro interno' });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        // o app novo só chega se o service worker e o HTML forem reconferidos a cada abertura
        const name = path.basename(filePath);
        if (name === 'sw.js' || name === 'index.html' || name === 'manifest.webmanifest') {
          res.set('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.type('text').send('Interface não compilada. Rode "npm run build".'),
  );
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Acompanhamento de entregas HAJAN em http://localhost:${PORT}`);
  const lan = lanUrl();
  if (lan) console.log(`Na rede da empresa: ${lan}`);
  const tunel = tunnelUrl();
  const origem = tunel ?? `http://<ip 100.x do escritório>:${PORT}`;
  console.log(`Link para trabalhar de fora: ${origem}/api/visita?token=${VISITA_TOKEN}`);
  if (!tunel) console.log('  (instale o Tailscale neste computador para o link funcionar)');
  startWatch();
  startBillingWatch();
  runScan().then((result) => {
    console.log(
      `Leitura inicial: ${result.lastScan.imported} importados, ${result.lastScan.skipped} inalterados, ${result.lastScan.errors} com erro (${result.lastScanMs} ms)`,
    );
  });
  setInterval(() => runScan().catch(() => {}), 10 * 60 * 1000);
  if (process.argv.includes('--open')) {
    exec(`start "" http://localhost:${PORT}`);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso por outro programa. Feche-o e tente de novo.`);
    process.exit(1);
  }
  throw error;
});
