/* Destino depois do SSO (?proximo= em /api/auth/sso): o portal mnrs.com.br
   manda o médico direto para o banco de horas ou a folha de ponto dele.
   Só caminho interno desta app — nada de outro host, de "//host" (URL
   relativa ao protocolo), de barra invertida ou de /api. Fora disso, "/". */
export function destinoInterno(proximo: string | null | undefined): string {
    const p = (proximo ?? "").trim();
    if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || p.startsWith("/api/")) return "/";
    if (p.length > 200 || /[\u0000-\u001f]/.test(p)) return "/";
    return p;
}
