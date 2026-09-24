import { portaDoMedico } from "@/app/medico/porta-do-medico";

export const dynamic = "force-dynamic";

/** /banco-de-horas puro → Painel do médico já na seção do banco de horas. */
export default async function BancoDeHorasCurtoPage() {
    return portaDoMedico("banco-de-horas");
}
