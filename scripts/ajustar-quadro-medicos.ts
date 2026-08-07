/**
 * Limpeza do quadro de médicos do fechamento (2026-08-07, pedido do coordenador).
 *
 *   npx tsx scripts/ajustar-quadro-medicos.ts [--apply]
 *
 * Sem --apply é só relatório: nada é escrito.
 *
 * Três situações distintas, três tratamentos — a diferença importa, porque
 * achatar tudo em `is_active = false` apagaria a informação de quem apenas não
 * escala mas segue na casa:
 *
 *   DESLIGADO      → `is_active = false`. Saiu do serviço. Some do quadro, do
 *                    bot e das telas; os plantões que já deu continuam no
 *                    histórico e nos meses em que aparecem (a linha do médico
 *                    no fechamento vem do plantão, não do cadastro).
 *   NAO_PLANTONISTA→ metadata `isNaoPlantonista: true`. Continua ativo (pode ter
 *                    login, pode ser coordenação), mas não fecha mês: sai do
 *                    quadro do payment-closing e do acompanhamento de saldo
 *                    contratual. Se um dia cumprir plantão, reaparece por ele.
 *   ESTATUTARIO    → metadata `employmentType: "estatutario"`. Remunerado fora
 *                    deste sistema: continua no quadro, com valor devido zero e
 *                    fora dos filtros de contrato.
 *
 * Nada aqui apaga linha de médico. Toda mudança é um campo, e desfazer é rodar
 * o mesmo UPDATE ao contrário.
 *
 * A busca é por nome COMPLETO normalizado e exige acerto único: em produção há
 * "Oswaldo Alves Bastos Neves" e "Oswaldo Alves Bastos Neto", que são cadastros
 * diferentes. Nome que não bater exatamente um médico ativo aborta o script
 * antes de qualquer escrita.
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { mergeDoctorDirectoryMetadata } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";

type Acao = "desligado" | "nao_plantonista" | "estatutario";

const QUADRO: Record<Acao, string[]> = {
    // "Esses só não devem aparecer na view payment em filtros porque não dão plantão mesmo."
    nao_plantonista: [
        "Admin Sistema",
        "Oswaldo Alves Bastos Neves",
        "PAULO DE TARSO MONTEIRO ABRAHÃO",
        "ALECIANNE AZEVEDO BRAGA",
        "DANIEL DE AZEVEDO CASTELLO BRANCO",
    ],
    // "Esses saíram mesmo do serviço."
    desligado: [
        "Gabriel Ribeiro Sampaio Cruz",
        "João Gustavo dos Anjos Morais Oliveira",
        "Leonardo Rios Carteado",
        "Luiza Lessa Soares",
        "Marcio La Torre Pina",
        "Maria Fernanda Souza Uzeda da SIlva",
        "Victor Vilas Boas Mangabeira",
    ],
    // "Esses são estatutários."
    estatutario: [
        "Mariana Almeida Maynart Aires",
        "Rafael Marcelino Oliveira",
    ],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function main() {
    const apply = process.argv.includes("--apply");
    const db = getDb();

    const alvos = Object.entries(QUADRO).flatMap(([acao, nomes]) =>
        nomes.map((nome) => ({ acao: acao as Acao, nome, normalizado: normalizeDoctorName(nome) })));

    const rows = await db
        .select({
            id: doctors.id,
            fullName: doctors.fullName,
            normalizedName: doctors.normalizedName,
            isActive: doctors.isActive,
            metadata: doctors.metadata,
        })
        .from(doctors)
        .where(inArray(doctors.normalizedName, alvos.map((alvo) => alvo.normalizado)));

    const porNome = new Map<string, typeof rows>();
    for (const row of rows) {
        porNome.set(row.normalizedName, [...(porNome.get(row.normalizedName) ?? []), row]);
    }

    const problemas: string[] = [];
    for (const alvo of alvos) {
        const encontrados = porNome.get(alvo.normalizado) ?? [];
        if (encontrados.length === 0) {
            problemas.push(`NÃO ENCONTRADO: "${alvo.nome}"`);
        } else if (encontrados.length > 1) {
            problemas.push(`AMBÍGUO (${encontrados.length} cadastros): "${alvo.nome}"`);
        }
    }

    if (problemas.length > 0) {
        console.error("Abortado antes de escrever — resolva os nomes primeiro:");
        for (const problema of problemas) console.error(`  - ${problema}`);
        process.exit(1);
    }

    let mudancas = 0;
    for (const alvo of alvos) {
        const medico = (porNome.get(alvo.normalizado) ?? [])[0]!;
        const metadata = isPlainObject(medico.metadata) ? medico.metadata : {};

        if (alvo.acao === "desligado") {
            if (!medico.isActive) {
                console.log(`= ${medico.fullName}: já inativo`);
                continue;
            }
            mudancas += 1;
            console.log(`${apply ? "→" : "·"} ${medico.fullName}: is_active true → false`);
            if (apply) {
                await db.update(doctors).set({ isActive: false }).where(eq(doctors.id, medico.id));
            }
            continue;
        }

        if (alvo.acao === "nao_plantonista") {
            if (metadata.isNaoPlantonista === true) {
                console.log(`= ${medico.fullName}: já marcado como não plantonista`);
                continue;
            }
            mudancas += 1;
            console.log(`${apply ? "→" : "·"} ${medico.fullName}: metadata.isNaoPlantonista → true`);
            if (apply) {
                await db.update(doctors)
                    .set({ metadata: mergeDoctorDirectoryMetadata(metadata, { isNaoPlantonista: true }) })
                    .where(eq(doctors.id, medico.id));
            }
            continue;
        }

        if (String(metadata.employmentType ?? "").toLowerCase() === "estatutario") {
            console.log(`= ${medico.fullName}: já estatutário`);
            continue;
        }
        mudancas += 1;
        console.log(`${apply ? "→" : "·"} ${medico.fullName}: metadata.employmentType → estatutario`);
        if (apply) {
            await db.update(doctors)
                .set({ metadata: { ...metadata, employmentType: "estatutario" } })
                .where(eq(doctors.id, medico.id));
        }
    }

    console.log(`\n${mudancas} mudança(s) ${apply ? "aplicada(s)" : "pendente(s) — rode com --apply"}.`);
    process.exit(0);
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
