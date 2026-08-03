export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") {
        return;
    }
    const required = ["DATABASE_URL", "AUTH_SECRET"];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        // Derruba o boot em vez de servir leituras com escrita/login quebrados.
        throw new Error(`variáveis obrigatórias ausentes no boot: ${missing.join(", ")}`);
    }
}
