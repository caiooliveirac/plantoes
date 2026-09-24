import { portaDoMedico } from "./porta-do-medico";

export const dynamic = "force-dynamic";

/** /medico → Painel do médico, mês corrente (ver porta-do-medico.tsx). */
export default async function MedicoHomePage() {
    return portaDoMedico("painel");
}
