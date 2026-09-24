import { portaDoMedico } from "./porta-do-medico";

export const dynamic = "force-dynamic";

/** /medico → banco de horas do médico logado, mês corrente (ver porta-do-medico.tsx). */
export default async function MedicoHomePage() {
    return portaDoMedico("banco-de-horas");
}
