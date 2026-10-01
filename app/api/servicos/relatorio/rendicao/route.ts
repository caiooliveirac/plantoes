/* ==========================================================================
   GET /api/servicos/relatorio/rendicao?data=YYYY-MM-DD&turno=SD|SN
   Rendição das bases USA na virada que abre o turno pedido, para o relatório
   da chefia (relatorio.mnrs.com.br): quem estava no plantão anterior e a que
   horas saiu — o MESMO cálculo da tela Plantão Anterior
   (getPreviousOperationalBoard: P, P invertido, colapso de reabertura,
   fantasmas, saída efetiva pelo sucessor).

   Turno SD de D  → fecharam às 07:00 de D: SN de D-1 e P (SD+SN de D-1).
   Turno SN de D  → fecharam às 19:00 de D: SD de D e P invertido (SN D-1+SD D).

   Portão: x-escala-token (ESCALA_SSO_TOKEN), igual a /turno. Sem a variável: 503.
   Devolve { ok, rendicao: [{ id, codigo, medicoId, nome, nomeCompleto, bucket,
             programadoInicio, programadoFim, chegada, saida }] } — saida null
   = sem saída registrada.
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { getPreviousOperationalBoard, type PreviousOperationalBucket } from "@/services/board.service";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

const FECHAM_NA_VIRADA: Record<"SD" | "SN", PreviousOperationalBucket[]> = {
    SD: ["SN", "P"],
    SN: ["SD", "P_INVERTIDO"],
};

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const data = request.nextUrl.searchParams.get("data") ?? "";
    const turno = request.nextUrl.searchParams.get("turno");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || (turno !== "SD" && turno !== "SN")) {
        return NextResponse.json({ error: "invalid_params" }, { status: 400 });
    }
    // Salvador = UTC-3 fixo. Referência 1 h depois da virada: a tela vê, desse
    // ponto, o plantão que acabou de fechar (SD → full-prev, SN → sd-only-current).
    const referencia = new Date(Date.parse(`${data}T00:00:00-03:00`) + (turno === "SD" ? 8 : 20) * 3600e3);

    try {
        const board = await getPreviousOperationalBoard(referencia);
        const buckets = new Set(FECHAM_NA_VIRADA[turno]);
        const rendicao = board.sections
            .filter((s) => buckets.has(s.bucket))
            .flatMap((s) => s.entries)
            .filter((e) => e.domain === "intervention")
            .map((e) => ({
                id: e.occupancyId,
                // P com troca de base vem "SM01 -> CB02": rendeu na última
                codigo: e.targetCode.split(" -> ").at(-1) ?? e.targetCode,
                medicoId: e.doctorId,
                nome: e.displayName?.trim() || e.doctorName,
                nomeCompleto: e.doctorName,
                bucket: e.bucket,
                programadoInicio: e.scheduledStartAt,
                programadoFim: e.scheduledEndAt,
                chegada: e.startedAt,
                saida: e.endedAt,
            }));
        return NextResponse.json({ ok: true, rendicao }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        console.error(`[relatorio-rendicao] ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "unavailable" }, { status: 500 });
    }
}
