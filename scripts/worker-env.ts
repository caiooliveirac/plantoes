// Carrega o .env correto ANTES dos demais módulos (imports executam em ordem)
// e aborta na hora se env crítico faltar. Sem isso o worker sobe "online" mas
// falha todos os ciclos quando o pm2 é reiniciado sem ambiente (apagão de 01/08/2026).
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const REQUIRED = ["DATABASE_URL"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
    console.error(`[worker-env] variáveis obrigatórias ausentes: ${missing.join(", ")} — abortando para o pm2 reerguer com ambiente completo.`);
    process.exit(1);
}
