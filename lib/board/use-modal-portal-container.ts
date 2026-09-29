"use client";

import { useEffect, useState } from "react";

/**
 * Destino do portal dos modais do quadro.
 *
 * Sem container o Radix monta o modal direto no <body>, fora de .pagina-kairos
 * — e só lá dentro valem os tokens do tema (kairos-ponte.css) e os overrides de
 * modal das telas migradas (kairos-plantoes.css). Fora dele o painel nascia com
 * a paleta dark glass legada: caixa preta sobre o quadro claro.
 *
 * null (SSR, ou página sem .pagina-kairos) = o <body> de sempre.
 */
export function useModalPortalContainer() {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setContainer(document.querySelector<HTMLElement>(".pagina-kairos"));
    }, []);
    return container;
}
