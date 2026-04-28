import { NextRequest, NextResponse } from "next/server";
import { parseDoctorImportFile, previewDoctorImport, summarizeDoctorImport } from "@/modules/doctors/importer";
import { hasDatabaseUrl } from "@/db";

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => null) as {
        fileName?: string;
        content?: string;
        dryRun?: boolean;
    } | null;

    if (!body?.fileName || !body.content) {
        return NextResponse.json({ error: "fileName and content are required." }, { status: 400 });
    }

    const rows = parseDoctorImportFile(body.fileName, body.content);
    const summary = summarizeDoctorImport(rows);

    if (!hasDatabaseUrl()) {
        return NextResponse.json({ mode: "dry-run", summary });
    }

    const preview = await previewDoctorImport(rows);

    if (body.dryRun === false) {
        return NextResponse.json({
            error: "Aplicação bloqueada via API para garantir backup obrigatório. Use o script db:import-doctors no servidor.",
            mode: "dry-run",
            summary,
            preview,
        }, { status: 409 });
    }

    return NextResponse.json({ mode: "dry-run", summary, preview });
}
