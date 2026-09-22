import { redirect } from "next/navigation";

/** Atalho curto para compartilhar: abre a mesa com o painel de login já aberto. */
export default function EntrarPage() {
    redirect("/?entrar=1");
}
