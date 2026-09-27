import { after } from "next/server";

/** Registro do monitor de acessos depois da resposta (after do Next), sem atrasar
    o pedido. Fora de um pedido — teste chamando o handler direto, script — o
    after() lança; aí a tarefa roda já, sem esperar. As tarefas do monitor nunca
    lançam (services/acessos.service.ts). */
export function depoisDaResposta(tarefa: () => Promise<unknown>) {
    try {
        after(tarefa);
    } catch {
        void tarefa();
    }
}
