import type { ReactNode } from "react";
import { CascaAdmin } from "@/components/casca/casca-admin";

/* A casca a partir da sessão: o papel legível no rodapé da lateral. Usada no
   /admin (layout) e nas telas da coordenação fora dele (Mesa, turno anterior). */

const PAPEL: Record<string, string> = {
    admin: "Administração",
    chief: "Chefia",
    doctor: "Médico",
    payment_closing_limited: "Fechamento (NF/processo)",
    radio_operador: "Rádio-operador",
    tarm: "TARM",
    enfermeiro: "Enfermeiro(a)",
};

export function CascaDaSessao({
    email,
    roles,
    children,
}: {
    email: string;
    roles: readonly string[];
    children: ReactNode;
}) {
    const papel = roles
        .filter((r) => r !== "portal")
        .map((r) => PAPEL[r] ?? r)
        .join(" · ");
    return (
        <CascaAdmin email={email} papel={papel}>
            {children}
        </CascaAdmin>
    );
}
