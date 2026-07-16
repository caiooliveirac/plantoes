function normalizeShiftToken(value: string | null | undefined) {
    const normalized = value?.trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    if (normalized === "SD" || normalized === "DIURNO") {
        return "SD" as const;
    }

    if (normalized === "SN" || normalized === "NOTURNO") {
        return "SN" as const;
    }

    return null;
}

function formatDateParts(year: number, month: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateToken(value: string | null | undefined, reference = new Date()) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    if (normalized === "hoje") {
        const local = new Date(reference.getTime() - (3 * 60 * 60000));
        return formatDateParts(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
    }

    if (normalized === "ontem") {
        const local = new Date(reference.getTime() - (3 * 60 * 60000) - 86400000);
        return formatDateParts(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
    }

    const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (brMatch) {
        return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
    }

    return null;
}

// Usages como exemplos preenchidos, prontos para copiar. No corrigir, o "|" tem um
// único significado: separar os campos do comando.
export const TELEGRAM_PAYMENT_REPORT_USAGE = "/pagamento conferir 2026-04-07 SD (data e turno opcionais — turno é SD ou SN)";
export const TELEGRAM_PAYMENT_CORRECTION_USAGE = "/pagamento corrigir PM04 | Ana Souza | 2026-04-07 | SD | motivo da correção (data, turno e motivo opcionais — turno é SD ou SN)";
export const TELEGRAM_PAYMENT_DIGEST_USAGE = "/pagamento [mês] (ex.: /pagamento, /pagamento 05, /pagamento maio)";

const MONTH_NAMES_PT: Record<string, number> = {
    janeiro: 1, jan: 1,
    fevereiro: 2, fev: 2,
    marco: 3, mar: 3,
    abril: 4, abr: 4,
    maio: 5, mai: 5,
    junho: 6, jun: 6,
    julho: 7, jul: 7,
    agosto: 8, ago: 8,
    setembro: 9, set: 9,
    outubro: 10, out: 10,
    novembro: 11, nov: 11,
    dezembro: 12, dez: 12,
};

function stripAccents(value: string) {
    return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Converte um token de mês (vazio, "05", "5", "maio", "março", "2026-05") em
// monthKey "YYYY-MM". Vazio → null (mês atual). Sem ano, escolhe a ocorrência mais
// recente daquele mês (este ano se já passou, senão ano anterior).
export function resolveMonthKeyToken(token: string | null | undefined, reference = new Date()): string | null {
    const normalized = stripAccents((token ?? "").trim().toLowerCase());
    if (!normalized) {
        return null;
    }

    const local = new Date(reference.getTime() - (3 * 60 * 60000));
    const currentYear = local.getUTCFullYear();
    const currentMonth = local.getUTCMonth() + 1;

    const ymMatch = normalized.match(/^(\d{4})-(\d{2})$/);
    if (ymMatch) {
        const month = Number(ymMatch[2]);
        return month >= 1 && month <= 12 ? `${ymMatch[1]}-${ymMatch[2]}` : null;
    }

    const month = /^\d{1,2}$/.test(normalized) ? Number(normalized) : MONTH_NAMES_PT[normalized] ?? null;
    if (!month || month < 1 || month > 12) {
        return null;
    }

    const year = month <= currentMonth ? currentYear : currentYear - 1;
    return `${year}-${String(month).padStart(2, "0")}`;
}

export type TelegramPaymentDigestCommand = {
    name: "payment_digest";
    monthKey: string | null;
    rawBody: string;
};

// Reconhece "/pagamento" sozinho ou "/pagamento <mês>" (sem os subcomandos
// conferir/corrigir, que continuam tratados por parseTelegramPaymentAdminCommand).
export function parseTelegramPaymentDigestCommand(text: string, reference = new Date()): TelegramPaymentDigestCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const body = match[1]?.trim() ?? "";
    if (!body) {
        return { name: "payment_digest", monthKey: null, rawBody: "" };
    }

    const tokens = body.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) {
        return null;
    }

    const monthKey = resolveMonthKeyToken(tokens[0], reference);
    if (!monthKey) {
        return null;
    }

    return { name: "payment_digest", monthKey, rawBody: body };
}

export const TELEGRAM_PAYMENT_CODENAME_USAGE = "/pagamento codinome Nome Completo";
export const TELEGRAM_PAYMENT_SELF_SERVICE_USAGE = "/pagamento <seu codinome> [mês]";
export const TELEGRAM_PAYMENT_PROFILE_SETUP_USAGE = "/pagamento cadastro [seu codinome]";
export const TELEGRAM_PAYMENT_RESET_ALL_USAGE = "/pagamento resetar-todos CONFIRMO";

export type TelegramPaymentProfileSetupCommand = {
    name: "payment_profile_setup";
    codename: string | null;
};

// Autoatendimento para preencher razao social e CNPJ usados na folha de ponto.
// Aceita "/pagamento cadastro" (pergunta o codinome) ou
// "/pagamento cadastro <codinome>" (vai direto para o formulario guiado).
export function parseTelegramPaymentProfileSetupCommand(text: string): TelegramPaymentProfileSetupCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s+(?:cadastro|cadastrar|empresa)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rest = (match[1] ?? "").trim();
    const codename = rest ? rest.split(/\s+/)[0] : null;
    return { name: "payment_profile_setup", codename };
}

export type TelegramPaymentResetAllCommand = {
    name: "payment_reset_all";
    confirmed: boolean;
};

// Admin: "/pagamento resetar-todos" (pede confirmação) e "/pagamento resetar-todos
// CONFIRMO" (executa o reset geral). "codinome" não casa aqui (resetar-todos != codinome).
export function parseTelegramPaymentResetAllCommand(text: string): TelegramPaymentResetAllCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s+resetar-todos\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }
    const rest = (match[1] ?? "").trim().toUpperCase();
    return { name: "payment_reset_all", confirmed: rest === "CONFIRMO" };
}

export const TELEGRAM_RESET_CODINOME_USAGE = "/resetcodinome Nome Completo (ou o codinome atual)";

export type TelegramResetCodinomeCommand = {
    name: "reset_codinome";
    query: string;
};

// Comando dedicado de reset de UM codinome, por nome OU pelo codinome atual.
export function isTelegramResetCodinomeCommandText(text: string) {
    return /^\/resetcodinome(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramResetCodinomeCommand(text: string): TelegramResetCodinomeCommand | null {
    const match = text.trim().match(/^\/resetcodinome(?:@\w+)?\s+([\s\S]+)$/i);
    if (!match) {
        return null;
    }
    const query = match[1].trim();
    return query ? { name: "reset_codinome", query } : null;
}

// "/pagamento listar" — exporta a lista atual de codinomes (admin).
export function parseTelegramPaymentListCommand(text: string) {
    return /^\/pagamento(?:@\w+)?\s+listar\b\s*$/i.test(text.trim()) ? { name: "payment_list" as const } : null;
}

export type TelegramPaymentCodenameAdminCommand = {
    name: "payment_codename";
    doctorName: string;
    rawBody: string;
};

// Admin: "/pagamento codinome <Nome Completo>" gera/reseta o codinome do médico.
export function parseTelegramPaymentCodenameAdminCommand(text: string): TelegramPaymentCodenameAdminCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s+codinome\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }
    const doctorName = match[1]?.trim() ?? "";
    if (!doctorName) {
        return null;
    }
    return { name: "payment_codename", doctorName, rawBody: doctorName };
}

export type TelegramPaymentSelfServiceCommand = {
    name: "payment_self";
    codename: string | null;
    monthKey: string | null;
};

// Médico (não admin): "/pagamento <codinome> [mês]". Primeiro token é o codinome;
// segundo (opcional) é o mês. Sem token → codename null (pedir identificação).
export function parseTelegramPaymentSelfServiceCommand(text: string, reference = new Date()): TelegramPaymentSelfServiceCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }
    const body = match[1]?.trim() ?? "";
    if (!body) {
        return { name: "payment_self", codename: null, monthKey: null };
    }
    const tokens = body.split(/\s+/).filter(Boolean);
    const monthKey = tokens.length >= 2 ? resolveMonthKeyToken(tokens[1], reference) : null;
    return { name: "payment_self", codename: tokens[0] ?? null, monthKey };
}

export type TelegramPaymentAdminCommand =
    | {
        name: "payment_report";
        operationalDate: string | null;
        shiftLabel: "SD" | "SN" | null;
        rawBody: string;
    }
    | {
        name: "payment_correct";
        targetCode: string;
        doctorName: string;
        operationalDate: string | null;
        shiftLabel: "SD" | "SN" | null;
        note: string | null;
        rawBody: string;
    };

export function isTelegramPaymentAdminCommandText(text: string) {
    return /^\/pagamento(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramPaymentAdminCommand(text: string, reference = new Date()): TelegramPaymentAdminCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s+(conferir|corrigir)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const action = match[1]?.toLowerCase();
    const rawBody = match[2]?.trim() ?? "";

    if (action === "conferir") {
        if (!rawBody) {
            return {
                name: "payment_report",
                operationalDate: null,
                shiftLabel: null,
                rawBody,
            };
        }

        const tokens = rawBody.split(/\s+/).filter(Boolean);
        if (tokens.length === 1) {
            const shiftLabel = normalizeShiftToken(tokens[0]);
            if (!shiftLabel) {
                return null;
            }

            return {
                name: "payment_report",
                operationalDate: null,
                shiftLabel,
                rawBody,
            };
        }

        if (tokens.length !== 2) {
            return null;
        }

        const operationalDate = normalizeDateToken(tokens[0], reference);
        const shiftLabel = normalizeShiftToken(tokens[1]);
        if (!operationalDate || !shiftLabel) {
            return null;
        }

        return {
            name: "payment_report",
            operationalDate,
            shiftLabel,
            rawBody,
        };
    }

    const parts = rawBody.split("|").map((item) => item.trim()).filter((item, index) => index < 2 || item.length > 0);
    if (parts.length < 2) {
        return null;
    }

    const targetCode = parts[0]?.trim().toUpperCase().replace(/\s+/g, "") ?? "";
    const doctorName = parts[1]?.trim() ?? "";
    if (!targetCode || !doctorName) {
        return null;
    }

    let operationalDate: string | null = null;
    let shiftLabel: "SD" | "SN" | null = null;
    let note: string | null = null;

    if (parts.length >= 3) {
        const maybeDate = normalizeDateToken(parts[2], reference);
        const maybeShift = normalizeShiftToken(parts[2]);
        if (maybeDate) {
            operationalDate = maybeDate;
            shiftLabel = parts[3] ? normalizeShiftToken(parts[3]) : null;
            if (!shiftLabel) {
                return null;
            }
            note = parts.slice(4).join(" | ").trim() || null;
        } else if (maybeShift) {
            shiftLabel = maybeShift;
            note = parts.slice(3).join(" | ").trim() || null;
        } else {
            note = parts.slice(2).join(" | ").trim() || null;
        }
    }

    return {
        name: "payment_correct",
        targetCode,
        doctorName,
        operationalDate,
        shiftLabel,
        note,
        rawBody,
    };
}