import { useState } from 'react';
import { api, type ImportacaoResultado, type TipoImportacao } from '../api';

const ROTULOS: Record<TipoImportacao, string> = {
  clientes: 'Clientes — aba Infos Clientes',
  produtos: 'Produtos — aba Infos Produtos',
  limites: 'Limites — 1ª aba',
  unidades: 'Unidades — aba SiglasUnidades',
};

/** Singular e plural de cada tabela, para as contagens não saírem como "1 clientes". */
const NOMES: Record<TipoImportacao, [string, string]> = {
  clientes: ['cliente', 'clientes'],
  produtos: ['produto', 'produtos'],
  limites: ['limite', 'limites'],
  unidades: ['unidade', 'unidades'],
};

const TIPOS = Object.keys(ROTULOS) as TipoImportacao[];

const comNome = (tipo: TipoImportacao, total: number) => `${total} ${NOMES[tipo][total === 1 ? 0 : 1]}`;

/** Tipos com alguma linha, na ordem das planilhas; evita poluir o painel com zeros. */
const comLinhas = (totais: Record<TipoImportacao, number>) => TIPOS.filter((tipo) => totais[tipo] > 0);

export function ImportarPlanilhasScreen() {
  const [arquivos, setArquivos] = useState<Partial<Record<TipoImportacao, File>>>({});
  // muda a cada importação concluída: remonta os <input type=file> e apaga os nomes exibidos
  const [versao, setVersao] = useState(0);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ImportacaoResultado | null>(null);

  const escolher = (tipo: TipoImportacao, arquivo: File | undefined) => {
    setArquivos((atual) => {
      const proximo = { ...atual };
      if (arquivo) proximo[tipo] = arquivo;
      else delete proximo[tipo];
      return proximo;
    });
  };

  const enviar = async () => {
    if (busy) return;
    const escolhidos = TIPOS.filter((tipo) => arquivos[tipo]);
    if (escolhidos.length === 0) {
      setErro('escolha pelo menos uma planilha');
      return;
    }
    const tabelas = escolhidos.map((tipo) => NOMES[tipo][1]).join(', ');
    const confirmado = window.confirm(
      `A importação substitui as tabelas de ${tabelas}: as linhas atuais desses tipos serão apagadas e ` +
        'trocadas pelas das planilhas escolhidas. O servidor cria um backup automático do banco antes de ' +
        'gravar. Continuar?',
    );
    if (!confirmado) return;
    setBusy(true);
    setErro(null);
    setResultado(null);
    try {
      setResultado(await api.importarPlanilhas(arquivos));
      setArquivos({});
      setVersao((atual) => atual + 1);
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui importar');
    } finally {
      setBusy(false);
    }
  };

  const importados = resultado ? comLinhas(resultado.contagens) : [];
  const ignorados = resultado ? comLinhas(resultado.ignoradas) : [];

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
          A importação substitui as tabelas da base pelos dados das planilhas enviadas. Antes de gravar, o
          servidor cria um backup automático do banco na pasta de backups configurada e mantém os 10 mais
          recentes. Se qualquer planilha estiver inválida, nada é alterado.
        </p>
        <div className="emissor-grade">
          {TIPOS.map((tipo) => (
            <label key={tipo}>
              <span>{ROTULOS[tipo]}</span>
              <input
                key={`${tipo}-${versao}`}
                type="file"
                accept=".xlsx"
                disabled={busy}
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
        {erro && (
          <p className="alert" role="alert">
            {erro}
          </p>
        )}
        {/* A região viva tem de existir antes do texto: montada junto do resultado,
            o leitor de tela não anuncia a importação concluída. */}
        <div className="emissor-resultado" aria-live="polite">
          {resultado && (
            <>
              <p>
                {importados.length > 0
                  ? `Importado: ${importados.map((tipo) => comNome(tipo, resultado.contagens[tipo])).join(' · ')}`
                  : 'Nenhuma linha importada.'}
              </p>
              {ignorados.length > 0 && (
                <p className="emissor-ignoradas">
                  Linhas ignoradas (sem código, nome, descrição ou sigla):{' '}
                  {ignorados.map((tipo) => comNome(tipo, resultado.ignoradas[tipo])).join(' · ')}
                </p>
              )}
              <p className="hint">
                Backup: <code>{resultado.backup}</code>
              </p>
            </>
          )}
        </div>
      </section>
    </section>
  );
}
