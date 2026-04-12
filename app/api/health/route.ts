import { NextResponse } from "next/server";
import { assertSingleRuntimeConfig, getRuntimeIdentity } from "@/lib/runtime-identity";

export async function GET() {
    const runtime = getRuntimeIdentity();
    let guard = "ok";

    try {
        assertSingleRuntimeConfig("api.health");
    } catch (error) {
        guard = error instanceof Error ? error.message : "runtime_guard_failed";
    }

    return NextResponse.json({
        ok: true,
        service: "operations-v2",
        timestamp: new Date().toISOString(),
        runtime,
        runtimeGuard: guard,
    });
}
