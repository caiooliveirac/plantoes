/**
 * verificacao-pos-virada.ts
 *
 * Roda à mão as verificações de docs/verificacao-saidas-continuidade.md (itens
 * 1 a 6) e imprime o resumo. NÃO ENVIA NADA e NÃO GRAVA NADA — é a mesma função
 * que o worker agenda após cada virada (flag VERIFICACAO_POS_VIRADA).
 *
 * Uso (contra produção, SOMENTE LEITURA, pelo túnel SSH — ver
 * docs/agent-operations.md §3):
 *   DATABASE_URL="$PLANTOES_RO_URL" npx tsx scripts/verificacao-pos-virada.ts [--horas 48] [--json]
 *
 * Sem --horas, a janela são as últimas 12h (um turno) até agora.
 */
import { closeDb, hasDatabaseUrl } from "@/db";
import { formatVerificacaoResumo, runVerificacaoPosVirada } from "@/services/verificacao-pos-virada.service";

const asJson = process.argv.includes("--json");
const horasIndex = process.argv.indexOf("--horas");
const horas = horasIndex >= 0 ? Number(process.argv[horasIndex + 1]) || 12 : 12;

async function main() {
    if (!hasDatabaseUrl()) {
        throw new Error("DATABASE_URL não configurada.");
    }
    const fim = new Date();
    const inicio = new Date(fim.getTime() - horas * 60 * 60 * 1000);
    const result = await runVerificacaoPosVirada({ inicio, fim });
    console.log(asJson ? JSON.stringify(result, null, 2) : formatVerificacaoResumo(result));
    console.log("\nNada enviado nem gravado por este script.");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
