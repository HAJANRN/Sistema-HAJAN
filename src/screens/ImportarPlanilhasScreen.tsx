import { useState } from 'react';
import { api, type ImportacaoResultado } from '../api';

type Tipo = 'clientes' | 'produtos' | 'limites' | 'unidades';

const ROTULOS: Record<Tipo, string> = {
  clientes: 'Clientes — aba Infos Clientes',
  produtos: 'Produtos — aba Infos Produtos',
  limites: 'Limites — 1ª aba',
  unidades: 'Unidades — aba SiglasUnidades',
};

export function ImportarPlanilhasScreen() {
  const [arquivos, setArquivos] = useState<Partial<Record<Tipo, File>>>({});
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ImportacaoResultado | null>(null);

  const escolher = (tipo: Tipo, arquivo: File | undefined) => {
    setArquivos((atual) => {
      const proximo = { ...atual };
      if (arquivo) proximo[tipo] = arquivo;
      else delete proximo[tipo];
      return proximo;
    });
  };

  const enviar = async () => {
    if (busy) return;
    if (Object.keys(arquivos).length === 0) {
      setErro('escolha pelo menos uma planilha');
      return;
    }
    setBusy(true);
    setErro(null);
    setResultado(null);
    try {
      setResultado(await api.importarPlanilhas(arquivos));
      setArquivos({});
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui importar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="emissor-screen">
      <header className="emissor-cabecalho">
        <div>
          <span className="eyebrow">Digitação de pedidos</span>
          <h1>Importar planilhas</h1>
        </div>
      </header>

      <section className="card">
        <p className="hint">
          A importação substitui a base do tipo enviado. Antes de gravar, o servidor cria um backup em{' '}
          <code>data/backups</code> e mantém os 10 mais recentes. Se qualquer planilha estiver inválida, nada
          é alterado.
        </p>
        <div className="emissor-grade">
          {(Object.keys(ROTULOS) as Tipo[]).map((tipo) => (
            <label key={tipo}>
              <span>{ROTULOS[tipo]}</span>
              <input
                type="file"
                accept=".xlsx"
                onChange={(event) => escolher(tipo, event.target.files?.[0])}
              />
            </label>
          ))}
        </div>
        <div className="emissor-acoes" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => void enviar()} disabled={busy}>
            {busy ? 'Importando…' : 'Importar'}
          </button>
        </div>
        {erro && <p className="alert">{erro}</p>}
        {resultado && (
          <div className="emissor-resultado">
            <p>
              Importado:{' '}
              {Object.entries(resultado.contagens)
                .filter(([, total]) => total > 0)
                .map(([tipo, total]) => `${total} ${tipo}`)
                .join(' · ')}
            </p>
            <p className="hint">
              Backup: <code>{resultado.backup}</code>
            </p>
          </div>
        )}
      </section>
    </section>
  );
}
