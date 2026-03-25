import { NextResponse } from "next/server";

export async function GET() {
    return NextResponse.json({
        ok: true,
        service: "operations-v2",
        timestamp: new Date().toISOString(),
    });
}
