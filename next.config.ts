import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    reactStrictMode: true,
    /**
     * Permite buildar num diretório separado e trocar pelo antigo só no fim.
     *
     * O deploy precisa de build LIMPO — o incremental por cima do .next antigo
     * deixa manifesto órfão quando o deploy remove rotas, e isso já derrubou o
     * /admin/payment-closing em produção. Mas apagar o .next antes de buildar
     * tira o build de baixo do processo que está no ar, e a produção fica fora
     * durante toda a compilação.
     *
     * Com isto o deploy builda em .next.build e só then troca, atomicamente.
     * Em runtime a variável não é definida e o valor volta ao padrão .next.
     */
    distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
