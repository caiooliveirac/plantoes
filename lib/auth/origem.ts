/* Mutação vinda de outro site não passa (CSRF). O cookie de sessão é
   SameSite=Lax, o que já barra POST de outro domínio — mas não de um
   subdomínio irmão: tabela., triagem. e lab-*.mnrs.com.br são o "mesmo site"
   para o navegador e levariam o cookie junto.

   O navegador diz de onde veio o pedido em `Sec-Fetch-Site` (não dá para
   forjar por script): só `same-origin` (o próprio app) e `none` (digitado,
   favorito) passam. Sem esse cabeçalho (navegador antigo), `Origin` presente
   precisa ser a do app (AUTH_URL). Sem os dois é chamada de servidor — porteiro,
   webhook do Telegram, contas-portal —, que se autentica por token próprio. */
const METODOS_QUE_MUDAM = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function mutacaoDeOutroSite(
    metodo: string,
    headers: Headers,
    authUrl: string | undefined = process.env.AUTH_URL,
): boolean {
    if (!METODOS_QUE_MUDAM.has(metodo.toUpperCase())) return false;
    const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
    if (site) return site !== "same-origin" && site !== "none";
    const origem = headers.get("origin")?.trim();
    if (!origem || !authUrl?.trim()) return false;
    try {
        return new URL(origem).origin !== new URL(authUrl.trim()).origin;
    } catch {
        return true;
    }
}
