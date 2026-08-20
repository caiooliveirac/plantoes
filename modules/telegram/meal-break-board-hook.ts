/**
 * Gancho fino para mutações do quadro. Import dinâmico quebra o ciclo
 * regulation/service → meal-breaks → board.service → regulation/service.
 */
export async function hookMealBreakAfterBoardChange(params?: {
    actorUserId?: string | null;
    referenceAt?: Date;
}) {
    try {
        const { maybeReconcileLiveMealBreakSession } = await import("@/modules/telegram/meal-breaks");
        await maybeReconcileLiveMealBreakSession({
            trigger: "board_change",
            actorTelegramId: params?.actorUserId ?? null,
            referenceAt: params?.referenceAt ?? new Date(),
        });
    } catch (error) {
        console.error("[meal-breaks] falha ao reconciliar divisão após mudança no quadro", error);
    }
}
