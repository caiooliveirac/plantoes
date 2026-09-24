import { portaDoMedico } from "../porta-do-medico";

export const dynamic = "force-dynamic";

/** /medico/folha-ponto → folha de ponto do médico logado, mês corrente. */
export default async function MedicoFolhaPontoPage() {
    return portaDoMedico("folha-ponto");
}
