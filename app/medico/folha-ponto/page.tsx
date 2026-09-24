import { portaDoMedico } from "../porta-do-medico";

export const dynamic = "force-dynamic";

/** /medico/folha-ponto → Painel do médico (pagamento do mês e a folha para gerar logo abaixo). */
export default async function MedicoFolhaPontoPage() {
    return portaDoMedico("painel");
}
