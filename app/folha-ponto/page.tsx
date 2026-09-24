import { portaDoMedico } from "@/app/medico/porta-do-medico";

export const dynamic = "force-dynamic";

/** /folha-ponto puro → Painel do médico (pagamento do mês e a folha para gerar logo abaixo). */
export default async function FolhaPontoCurtaPage() {
    return portaDoMedico("painel");
}
