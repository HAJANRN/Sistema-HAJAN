export function FinanceiroPagarScreen() {
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Financeiro</span>
            <h2>Contas a pagar</h2>
            <p className="panel-sub">Títulos de fornecedores, fretes e despesas da operação.</p>
          </div>
        </div>
      </section>

      <section className="empty">
        <h3>Ainda sem base de contas a pagar</h3>
        <p>
          O módulo está pronto para receber os títulos quando a planilha financeira da empresa for
          importada. Enquanto isso, os pagamentos continuam no controle atual do financeiro.
        </p>
      </section>
    </>
  );
}
