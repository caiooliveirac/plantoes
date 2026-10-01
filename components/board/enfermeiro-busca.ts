/**
 * Busca do seletor de enfermeiro(a) do plantão (EnfermeiroDoPlantao.tsx):
 * sem acento e sem caixa, por nome ou matrícula; todas as palavras digitadas
 * têm de aparecer. Pura — roda no navegador e nos testes.
 */

export interface CandidatoEnfermeiro {
    id: string;
    nome: string;
    matricula: string | null;
}

export function semAcento(texto: string) {
    return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function filtrarCandidatos(candidatos: readonly CandidatoEnfermeiro[], termo: string, limite = 50): CandidatoEnfermeiro[] {
    const palavras = semAcento(termo).split(/\s+/).filter(Boolean);
    if (palavras.length === 0) return candidatos.slice(0, limite);
    const achados: CandidatoEnfermeiro[] = [];
    for (const candidato of candidatos) {
        const alvo = `${semAcento(candidato.nome)} ${semAcento(candidato.matricula ?? "")}`;
        if (palavras.every((palavra) => alvo.includes(palavra))) {
            achados.push(candidato);
            if (achados.length >= limite) break;
        }
    }
    return achados;
}
