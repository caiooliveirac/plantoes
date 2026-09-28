import { AuthError, abrirVigiaDaMesa } from "@/lib/auth/server";
import { getBoardLiveVersion, subscribeBoardUpdates } from "@/lib/board-live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StreamCleanup = () => void;

/** De quanto em quanto tempo o stream aberto reconfere sessão e portão. */
const RECONFERE_A_CADA_MS = 30_000;

function encodeSseMessage(event: string, payload: Record<string, unknown>) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request) {
    // Quadro fechado: o stream só emite versão/motivo, mas sem sessão não serve
    // nem de oráculo de mudança. Checa antes de abrir o stream e, aberto, de
    // novo a cada 30 s: acabou o turno, sessão encerrada ou senha trocada →
    // evento `acesso-encerrado` e o stream fecha (o cliente recarrega).
    let aindaLiberada: () => Promise<boolean>;
    try {
        aindaLiberada = await abrirVigiaDaMesa();
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
                clearInterval(vigiaId);
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

            const vigiaId = setInterval(() => {
                void aindaLiberada().then((liberada) => {
                    if (liberada || closed) return;
                    enqueue(encodeSseMessage("acesso-encerrado", { emittedAt: new Date().toISOString() }));
                    cleanupStream();
                });
            }, RECONFERE_A_CADA_MS);

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