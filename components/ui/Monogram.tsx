"use client";

/**
 * Monograma de médico com matiz determinística derivada do nome: a mesma
 * pessoa tem sempre a mesma cor em escala, trocas e relatório — a cor vira
 * identidade visual, não decoração.
 */
export function monogramHue(name: string) {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
        hash = (hash * 31 + name.charCodeAt(index)) | 0;
    }
    return ((hash % 360) + 360) % 360;
}

export function monogramInitials(name: string) {
    const tokens = name.trim().split(/\s+/).filter((token) => token.length > 1);
    if (tokens.length === 0) return "?";
    if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
    return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
}

export function Monogram({ name, size = 28, ringed = false }: { name: string; size?: number; ringed?: boolean }) {
    const hue = monogramHue(name);
    return (
        <span
            className={`et-mono${ringed ? " ringed" : ""}`}
            style={{
                width: size,
                height: size,
                fontSize: Math.max(10, Math.round(size * 0.38)),
                background: `hsl(${hue} 42% 24%)`,
                color: `hsl(${hue} 72% 80%)`,
                borderColor: `hsl(${hue} 50% 38%)`,
            }}
            aria-hidden
        >
            {monogramInitials(name)}
        </span>
    );
}
