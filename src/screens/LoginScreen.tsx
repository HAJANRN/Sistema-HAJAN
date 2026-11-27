import { useState } from 'react';
import { entrar, trocarSenha } from '../sync';

interface Props {
  senhaDefinida: boolean;
  erroSessao: string | null;
  onAuthenticated: () => void;
  onRetry: () => void;
}

export function LoginScreen({ senhaDefinida, erroSessao, onAuthenticated, onRetry }: Props) {
  const [usuario, setUsuario] = useState('admin');
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enviar = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!senhaDefinida && senha !== confirmacao) {
      setErro('As senhas não conferem.');
      return;
    }

    setBusy(true);
    setErro(null);
    try {
      if (senhaDefinida) await entrar(senha, usuario);
      else await trocarSenha(senha, usuario);
      onAuthenticated();
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'Não foi possível validar o acesso.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <span className="brand-tile">
            <img className="brand-mark" src="/images/hajan-mark.png" alt="HAJAN" />
          </span>
          <span className="eyebrow">Acesso seguro</span>
        </div>
        <h1>Sistemas HAJAN</h1>
        <p className="login-description">
          Entre para acessar o acompanhamento de entregas e a emissão de pedidos.
        </p>

        {erroSessao ? (
          <div className="login-error" role="alert">
            <p>{erroSessao}</p>
            <button type="button" className="btn ghost" onClick={onRetry}>
              Tentar novamente
            </button>
          </div>
        ) : (
          <form className="login-form" onSubmit={enviar}>
            <label>
              <span>Usuário</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={usuario}
                onChange={(event) => setUsuario(event.target.value)}
                required
              />
            </label>
            <label>
              <span>{senhaDefinida ? 'Senha' : 'Crie a senha do escritório'}</span>
              <input
                type="password"
                name="password"
                autoComplete={senhaDefinida ? 'current-password' : 'new-password'}
                value={senha}
                onChange={(event) => setSenha(event.target.value)}
                required
                minLength={senhaDefinida ? undefined : 4}
              />
            </label>
            {!senhaDefinida && (
              <label>
                <span>Confirme a senha</span>
                <input
                  type="password"
                  name="passwordConfirmation"
                  autoComplete="new-password"
                  value={confirmacao}
                  onChange={(event) => setConfirmacao(event.target.value)}
                  required
                  minLength={4}
                />
              </label>
            )}
            <button type="submit" className="btn login-submit" disabled={!usuario || !senha || busy}>
              {busy ? 'Validando…' : senhaDefinida ? 'Entrar' : 'Criar senha e entrar'}
            </button>
            {erro && <p className="login-error" role="alert">{erro}</p>}
          </form>
        )}
        <p className="login-footnote">
          {senhaDefinida
            ? 'Use o usuário admin e a senha compartilhada do escritório.'
            : 'Primeiro acesso: crie a senha do escritório. Ela será compartilhada com o Emissor.'}
        </p>
      </section>
    </main>
  );
}
