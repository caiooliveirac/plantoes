import { portaDoMedico } from "@/app/medico/porta-do-medico";

export const dynamic = "force-dynamic";

/** /folha-ponto puro → folha de ponto do médico logado, mês corrente. */
export default async function FolhaPontoCurtaPage() {
    return portaDoMedico("folha-ponto");
}
