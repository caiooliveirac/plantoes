import { setMyCommands, type TelegramBotCommand } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";

// Menu de ações que aparece no botão "/" do chat PRIVADO de cada admin
// (TELEGRAM_ADMIN_IDS). Escopo por chat: o grupo e os demais usuários não veem.
const ADMIN_MENU_COMMANDS: TelegramBotCommand[] = [
    { command: "rc", description: "Reseta o codinome de UM médico (nome ou codinome)" },
    { command: "pagamento", description: "Folha do mês, conferir, corrigir, listar codinomes" },
    { command: "chave", description: "Chave do dia do checklist de uma USA" },
    { command: "checklist", description: "Menu do checklist das USAs (status, faltas, histórico)" },
    { command: "desfazer", description: "Lista e desfaz ações recentes (12h)" },
    { command: "slots", description: "Auditoria de ocupação por turno" },
    { command: "medico", description: "Cadastro/edição de médico" },
    { command: "piam", description: "Atribui/remove médico do PIAM" },
    { command: "psiq", description: "Marca/remove psiquiatra" },
    { command: "banco", description: "Ajusta banco de horas" },
    { command: "plantao", description: "Relato do turno atual" },
    { command: "comandos", description: "Tutorial completo do bot" },
];

// Menu do botão "/" para QUALQUER privado com o bot (escopo all_private_chats
// do Telegram; o menu por chat dos admins acima tem precedência e não muda).
// É a descobribilidade que faltava: "chave para checklist tão secreta que
// ninguém entendeu onde pedir" — agora o próprio Telegram lista o /chave.
const PRIVATE_MENU_COMMANDS: TelegramBotCommand[] = [
    { command: "chave", description: "Chave do dia do checklist da sua USA" },
    { command: "pagamento", description: "Consultar SEU pagamento (com codinome)" },
    { command: "ajuda", description: "Guia rápido do bot" },
];

/**
 * Sincroniza os menus de comandos: o de qualquer privado (all_private_chats) e
 * o do privado de cada admin. Idempotente — rodar a cada boot do worker mantém
 * os menus atualizados sem passo manual. Falha por admin é só logada (ex.:
 * admin que nunca abriu o privado do bot → "chat not found").
 */
export async function syncTelegramAdminCommandMenus() {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { synced: 0, failed: 0 };
    }
    let synced = 0;
    let failed = 0;
    try {
        await setMyCommands(PRIVATE_MENU_COMMANDS, { type: "all_private_chats" });
        synced += 1;
    } catch (error) {
        failed += 1;
        console.warn("[telegram-admin-menu] menu de privados falhou:", error instanceof Error ? error.message : error);
    }
    for (const adminId of getTelegramAdminUserIds()) {
        try {
            await setMyCommands(ADMIN_MENU_COMMANDS, { type: "chat", chat_id: Number(adminId) });
            synced += 1;
        } catch (error) {
            failed += 1;
            console.warn(`[telegram-admin-menu] falhou para admin ${adminId}:`, error instanceof Error ? error.message : error);
        }
    }
    return { synced, failed };
}
