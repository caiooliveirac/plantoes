import { AuthError, requireSessionForRead } from "@/lib/auth/server";
import { getBoardLiveVersion, subscribeBoardUpdates } from "@/lib/board-live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StreamCleanup = () => void;

function encodeSseMessage(event: string, payload: Record<string, unknown>) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request) {
    // Quadro fechado: o stream só emite versão/motivo, mas sem sessão não serve
    // nem de oráculo de mudança. Checa antes de abrir o stream.
    try {
        await requireSessionForRead();
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unauthorized." }), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }

    let cleanup: StreamCleanup | null = null;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            let closed = false;

            const enqueue = (chunk: string) => {
                if (closed) {
                    return;
                }

                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    closed = true;
                }
            };

            const cleanupStream = () => {
                if (closed) {
                    return;
                }

                closed = true;
                clearInterval(heartbeatId);
                unsubscribe();
                request.signal.removeEventListener("abort", cleanupStream);

                try {
                    controller.close();
                } catch {
                    return;
                }
            };

            enqueue(encodeSseMessage("ready", {
                version: getBoardLiveVersion(),
                emittedAt: new Date().toISOString(),
            }));

            const unsubscribe = subscribeBoardUpdates((event) => {
                enqueue(encodeSseMessage("board-update", event));
            });

            const heartbeatId = setInterval(() => {
                enqueue(": keep-alive\n\n");
            }, 15000);

            request.signal.addEventListener("abort", cleanupStream);
            cleanup = cleanupStream;
        },
        cancel() {
            cleanup?.();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}