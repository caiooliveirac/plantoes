import { NextRequest, NextResponse } from "next/server";
import { applyDoctorImport, parseDoctorImportFile, summarizeDoctorImport } from "@/modules/doctors/importer";
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

    if (body.dryRun !== false || !hasDatabaseUrl()) {
        return NextResponse.json({ mode: "dry-run", summary });
    }

    const result = await applyDoctorImport(rows);
    return NextResponse.json({ mode: "apply", summary, result });
}
