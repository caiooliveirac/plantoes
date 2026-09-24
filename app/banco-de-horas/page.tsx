import { portaDoMedico } from "@/app/medico/porta-do-medico";

export const dynamic = "force-dynamic";

/** /banco-de-horas puro → banco de horas do médico logado, mês corrente. */
export default async function BancoDeHorasCurtoPage() {
    return portaDoMedico("banco-de-horas");
}
