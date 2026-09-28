export const USER_ROLES = ["admin", "chief", "doctor", "payment_closing_limited", "portal", "radio_operador", "tarm"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * `portal` só vale para o login do portal mnrs.com.br (POST
 * /api/auth/verificar-escala, chamado pelo porteiro). Dentro do app Plantões
 * ele não conta: conta cujo único papel é `portal` é tratada exatamente como
 * `no_roles_assigned` — login recusado, sessão nula, SSO sem acesso.
 */
export const PORTAL_ROLE = "portal" as const satisfies UserRole;

/**
 * Operadores da Central: `radio_operador` (despacha unidades) e `tarm`
 * (telefonista, Técnico Auxiliar de Regulação Médica). Sem médico vinculado,
 * logo nunca "em turno" para o portão: veem a Mesa só para ler (toda escrita
 * da Mesa exige admin/chief) e só da rede da Central. Lá são isentos da
 * presença na Mesa — sem vez única, sem bloqueio por ociosidade
 * (docs/presenca-mesa.md). Dados e tirados pelo admin em /admin/acessos.
 */
export const RADIO_OPERADOR_ROLE = "radio_operador" as const satisfies UserRole;
export const TARM_ROLE = "tarm" as const satisfies UserRole;
export const OPERADORES_DA_CENTRAL = [RADIO_OPERADOR_ROLE, TARM_ROLE] as const;
export type OperadorDaCentral = (typeof OPERADORES_DA_CENTRAL)[number];

export function ehOperadorDaCentral(roles: readonly string[]): boolean {
    return roles.some((role) => (OPERADORES_DA_CENTRAL as readonly string[]).includes(role));
}

/** Papéis que abrem alguma coisa no app Plantões (tudo menos `portal`). */
export type PlantoesRole = Exclude<UserRole, typeof PORTAL_ROLE>;

export const PLANTOES_ROLES = USER_ROLES.filter((role): role is PlantoesRole => role !== PORTAL_ROLE);

export function isUserRole(value: string): value is UserRole {
    return USER_ROLES.includes(value as UserRole);
}

export function isPlantoesRole(value: string): value is PlantoesRole {
    return (PLANTOES_ROLES as readonly string[]).includes(value);
}

/** Filtra a lista crua de `user_roles` para os papéis que valem no app Plantões. */
export function rolesDoPlantoes(roles: readonly string[]): PlantoesRole[] {
    return roles.filter(isPlantoesRole);
}

/** Algum papel que abre o app Plantões? `portal` sozinho não abre. */
export function temAcessoAoPlantoes(roles: readonly string[]): boolean {
    return rolesDoPlantoes(roles).length > 0;
}

export function requireRole(userRoles: string[], requiredRole: UserRole) {
    if (!userRoles.includes(requiredRole)) {
        throw new Error(`Missing required role: ${requiredRole}.`);
    }
}
