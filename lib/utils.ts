import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Junta classes do Tailwind resolvendo conflitos (padrão do shadcn/21st). */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
