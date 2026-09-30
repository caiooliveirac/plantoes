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
    /**
     * O deploy (scripts/deploy-magalu.sh) só roda depois do typecheck do CI de
     * PR ou do validate, então lá o next build não checa tipos de novo (~20s
     * no servidor). Build local e do CI continuam checando.
     */
    typescript: { ignoreBuildErrors: process.env.NEXT_SKIP_TYPECHECK === "1" },
    experimental: {
        /**
         * Cache do compilador em <distDir>/cache/turbopack, reaproveitado no
         * próximo build (desligado por padrão no Next 16.2). O deploy copia o
         * .next/cache do build no ar para o .next.build limpo: é só cache do
         * compilador, sem os manifestos de rota que ficavam órfãos.
         */
        turbopackFileSystemCacheForBuild: true,
    },
};

export default nextConfig;
