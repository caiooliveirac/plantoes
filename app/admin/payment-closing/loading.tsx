/**
 * Skeleton do fechamento mensal: aparece imediatamente ao navegar entre meses
 * (client navigation via <Link>) enquanto o board do mês é montado no servidor.
 * Sem ele, o clique num mês ficava sem nenhum feedback durante todo o TTFB.
 */
export default function PaymentClosingLoading() {
    return (
        <main className="chief-payable-shell">
            <section className="chief-payable-hero">
                <div>
                    <p className="reports-kicker">Fechamento mensal do chefe</p>
                    <h1>Unidades pagáveis por médico e por dia</h1>
                    <p className="chief-payable-subtitle">Montando o fechamento do mês…</p>
                </div>
            </section>

            <section className="chief-payable-table-shell" aria-busy="true" aria-live="polite">
                <div className="chief-payable-loading-skeleton">
                    {Array.from({ length: 8 }, (_, index) => (
                        <div key={index} className="chief-payable-loading-bar" style={{ animationDelay: `${index * 90}ms` }} />
                    ))}
                </div>
            </section>
        </main>
    );
}
