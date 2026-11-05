import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { entrar, sair, subscribeSync, syncNow, syncSnapshot, trocarSenha } from '../sync';
import type { ImportStatus } from '../types';
import { relativeTime } from '../utils';

interface Props {
  onClose: () => void;
}

/** Importação, ajustes e servidor pedem senha; marcar entregas e anomalias não pede. */
export function ImportPanel({ onClose }: Props) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  if (sync.role !== 'administracao') return <SenhaPanel onClose={onClose} />;
  return <Painel onClose={onClose} />;
}

function SenhaPanel({ onClose }: Props) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enviar = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!senha || busy) return;
    setBusy(true);
    setErro(null);
    try {
      // primeira vez: quem abre define a senha e já entra
      if (sync.senhaDefinida) await entrar(senha);
      else await trocarSenha(senha);
      await syncNow();
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui conferir a senha');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal modal-small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="senha-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-brand">
            <img src="/images/hajan-mark.png" alt="" />
            <div>
              <span className="eyebrow">Área restrita</span>
              <h2 id="senha-title">Importação e ajustes</h2>
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        <form className="login-form" onSubmit={enviar}>
          <label>
            <span>{sync.senhaDefinida ? 'Senha do escritório' : 'Crie a senha (mínimo 4 caracteres)'}</span>
            <input
              type="password"
              value={senha}
              autoComplete="off"
              onChange={(event) => setSenha(event.target.value)}
            />
          </label>
          <button type="submit" className="btn" disabled={!senha || busy}>
            {busy ? 'Confirmando…' : sync.senhaDefinida ? 'Entrar' : 'Definir e entrar'}
          </button>
          {erro && <p className="attach-error">{erro}</p>}
        </form>

        <p className="hint">
          {sync.senhaDefinida
            ? 'Marcar entregas e registrar anomalias não precisa de senha — só a importação, os ajustes e o servidor.'
            : 'Nenhuma senha definida ainda. A primeira pessoa que criar aqui passa a ser o escritório; depois é só digitar.'}
        </p>
      </div>
    </div>
  );
}

function Painel({ onClose }: Props) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [etaForm, setEtaForm] = useState<{
    speed: string;
    stop: string;
  } | null>(null);
  const [savingEta, setSavingEta] = useState(false);
  const [etaSaved, setEtaSaved] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [novaSenha, setNovaSenha] = useState('');
  const [senhaSalva, setSenhaSalva] = useState(false);
  const [reiniciando, setReiniciando] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'sem resposta do servidor local');
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    api
      .settings()
      .then((settings) =>
        setEtaForm({
          speed: String(settings.speedKmh),
          stop: String(settings.stopMinutes),
        }),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const waitForScan = useCallback(async () => {
    const next = await load();
    if (next?.scanning) {
      timer.current = window.setTimeout(() => void waitForScan(), 2000);
    } else {
      setBusy(false);
      await syncNow();
    }
  }, [load]);

  const rescan = async (force: boolean) => {
    setBusy(true);
    try {
      await api.rescan(force);
      timer.current = window.setTimeout(() => void waitForScan(), 1500);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : 'não consegui iniciar a leitura');
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      // sem HTTPS o navegador não libera a área de transferência: o texto fica selecionável
    }
  };

  const salvarSenha = async () => {
    try {
      await trocarSenha(novaSenha);
      setNovaSenha('');
      setSenhaSalva(true);
      setError(null);
      window.setTimeout(() => setSenhaSalva(false), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'não consegui salvar a senha');
    }
  };

  /** O servidor se reabre sozinho; a requisição morre no caminho e isso é esperado. */
  const reiniciar = async () => {
    setReiniciando(true);
    try {
      await api.reiniciarServidor();
    } catch {
      // resposta pode não chegar antes do processo reiniciar
    }
    window.setTimeout(() => setReiniciando(false), 6000);
  };

  const deliveries = status?.deliveries ?? {};
  const totalDeliveries = Object.values(deliveries).reduce((sum, n) => sum + n, 0);
  const lan = status?.lan ?? null;

  const saveEta = async () => {
    if (!etaForm) return;
    setSavingEta(true);
    setEtaSaved(false);
    try {
      const saved = await api.saveSettings({
        speedKmh: Number(etaForm.speed),
        stopMinutes: Number(etaForm.stop),
      });
      setEtaForm({
        speed: String(saved.speedKmh),
        stop: String(saved.stopMinutes),
      });
      setError(null);
      setEtaSaved(true);
      await syncNow();
      window.setTimeout(() => setEtaSaved(false), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'não consegui salvar os ajustes');
    } finally {
      setSavingEta(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-brand">
            <img src="/images/hajan-mark.png" alt="" />
            <div>
              <span className="eyebrow">Origem dos pedidos</span>
              <h2 id="import-title">Importação</h2>
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        {error && <p className="alert">{error}</p>}

        {!status && !error && <p className="panel-sub">Consultando o servidor…</p>}

        {status && (
          <>
            <div className="import-summary">
              <div>
                <span>Última leitura</span>
                <strong>{relativeTime(status.lastScanAt)}</strong>
                <small>
                  {status.lastScanMs != null ? `${(status.lastScanMs / 1000).toFixed(0)} s` : '—'}
                  {status.scanning ? ' · lendo agora…' : ''}
                </small>
              </div>
              <div>
                <span>Pedidos</span>
                <strong>{status.orders}</strong>
                <small>{totalDeliveries} entregas</small>
              </div>
              <div>
                <span>Nesta leitura</span>
                <strong>{status.lastScan.imported}</strong>
                <small>
                  {status.lastScan.skipped} sem mudança · {status.lastScan.errors} com erro
                </small>
              </div>
            </div>

            {lan && (
              <div className="share-link">
                <span className="field-label">Link para a equipe (mesma rede)</span>
                <code
                  className="share-url"
                  onClick={(event) => {
                    const range = document.createRange();
                    range.selectNodeContents(event.currentTarget);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                  }}
                >
                  {lan}
                </code>
                <button type="button" className="btn small" onClick={() => void copyLink(lan)}>
                  {linkCopied ? 'copiado' : 'copiar'}
                </button>
                <p className="hint">
                  É só digitar esse endereço no navegador do celular ou do computador. O programa
                  continua lendo as planilhas a partir desta máquina, então ela precisa ficar
                  ligada.
                </p>
              </div>
            )}

            <h3 className="section-title">Pastas monitoradas</h3>
            <ul className="dir-list">
              {status.dirs.map((dir) => (
                <li key={dir.dir}>
                  <span className={`dir-state ${dir.exists ? 'ok' : 'missing'}`}>
                    {dir.exists ? 'ok' : 'off'}
                  </span>
                  <code title={dir.dir}>{dir.dir}</code>
                  <span className="dir-count">
                    {dir.exists
                      ? `${dir.files} ${dir.files === 1 ? 'arquivo' : 'arquivos'}`
                      : 'não encontrada'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="hint">
              Os pedidos são gravados pelo escritório nas pastas da rede. Não altere os arquivos por
              aqui: o app só lê. Para importar os pesos, salve o PDF do pedido em{' '}
              <code>pedidos-pdf</code>.
            </p>

            {etaForm && (
              <>
                <h3 className="section-title">Previsão de chegada</h3>
                <div className="eta-form">
                  <label>
                    <span>Velocidade média (km/h)</span>
                    <input
                      type="number"
                      min={20}
                      max={120}
                      step={1}
                      value={etaForm.speed}
                      onChange={(event) => setEtaForm({ ...etaForm, speed: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Descarga por parada (min)</span>
                    <input
                      type="number"
                      min={0}
                      max={480}
                      step={5}
                      value={etaForm.stop}
                      onChange={(event) => setEtaForm({ ...etaForm, stop: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void saveEta()}
                    disabled={savingEta}
                  >
                    {savingEta ? 'Salvando…' : etaSaved ? 'Salvo' : 'Salvar'}
                  </button>
                </div>
                <p className="hint">
                  A previsão parte às 06:00 do 1º cliente na data ENTREGA e usa a distância
                  rodoviária real entre as cidades ({status.road} trechos calculados; sem resposta
                  da rota, estima linha reta × 1,25). Chegadas fora do horário de recebimento
                  (segunda a sexta, 06:00–18:00) passam para a próxima janela. Na caixaria, a data
                  do agendamento ancora a previsão daquela entrega e das seguintes (clientes ESC não
                  são agendados). Ao marcar entregue ou anomalia, a próxima entrega pendente passa
                  automaticamente para Em rota.
                </p>
              </>
            )}

            {status.orphanPdfs.length > 0 && (
              <>
                <h3 className="section-title">PDFs aguardando planilha</h3>
                <ul className="issue-list">
                  {status.orphanPdfs.map((item) => (
                    <li key={item.file}>
                      <span>{item.file.split('\\').pop()}</span>
                      <small>{item.reason}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {status.errors.length > 0 && (
              <>
                <h3 className="section-title">Arquivos com problema</h3>
                <ul className="issue-list">
                  {status.errors.map((item) => (
                    <li key={`${item.path}-${item.imported_at}`}>
                      <span title={item.path}>{item.path.split('\\').pop()}</span>
                      <small>{item.error}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="section-title">Senha e servidor</h3>
            <div className="eta-form">
              <label>
                <span>Nova senha do escritório</span>
                <input
                  type="password"
                  value={novaSenha}
                  autoComplete="off"
                  onChange={(event) => setNovaSenha(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn ghost"
                onClick={() => void salvarSenha()}
                disabled={novaSenha.length < 4}
              >
                {senhaSalva ? 'Senha salva' : 'Salvar senha'}
              </button>
            </div>
            <div className="admin-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => void sair().then(onClose)}
              >
                Sair da área restrita
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => void reiniciar()}
                disabled={reiniciando}
              >
                {reiniciando ? 'Reiniciando…' : 'Reiniciar o servidor'}
              </button>
            </div>
            <p className="hint">
              A senha vale por 12 horas neste navegador. Reiniciar leva alguns segundos e nada se
              perde: as entregas já marcadas ficam no banco do servidor.
            </p>

            <footer className="modal-foot">
              <span className="panel-sub">
                {status.scanning
                  ? 'Lendo arquivos…'
                  : 'A leitura automática confere a rede a cada 15 segundos.'}
              </span>
              <div>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void rescan(false)}
                  disabled={busy}
                >
                  Verificar novas
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void rescan(true)}
                  disabled={busy}
                >
                  Reimportar tudo
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
