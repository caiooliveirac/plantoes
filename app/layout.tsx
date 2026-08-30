import type { Metadata } from "next";
import { DM_Mono, DM_Sans, Manrope, Space_Grotesk } from "next/font/google";
import ogImage from "@/components/og.jpg";
import { Toaster } from "@/components/board/Toaster";
import "./globals.css";

const metadataBase = new URL(process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br");

const manrope = Manrope({
    subsets: ["latin"],
    variable: "--font-sans",
});

const spaceGrotesk = Space_Grotesk({
    subsets: ["latin"],
    variable: "--font-display",
});

/* Tipografia Kairós — self-hosted pelo next/font, igual ao app escalas.
   As variáveis alimentam --fonte-sans/--fonte-mono em app/kairos.css; as
   telas legadas seguem em Manrope/Space Grotesk até migrarem. */
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--fonte-dm-sans" });
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--fonte-dm-mono" });

/* Anti-FOUC do tema Kairós: decide claro/escuro ANTES da primeira pintura.
   localStorage["kairos:tema"] → fallback prefers-color-scheme. Mesmo script
   do escalas — a preferência é compartilhada entre os dois apps quando
   servidos no mesmo domínio raiz, e o atributo só afeta telas migradas. */
const SCRIPT_TEMA = `try{var t=localStorage.getItem("kairos:tema");document.documentElement.dataset.tema=(t==="escuro"||t==="claro")?t:(matchMedia("(prefers-color-scheme: dark)").matches?"escuro":"claro")}catch(e){}`;

export const metadata: Metadata = {
    metadataBase,
    title: "Mesa Operacional SAMU",
    description: "Mesa operacional moderna para regulação, intervenção e comando de plantões SAMU",
    openGraph: {
        title: "Mesa Operacional SAMU",
        description: "Mesa operacional moderna para regulação, intervenção e comando de plantões SAMU",
        images: [{
            url: ogImage.src,
            width: ogImage.width,
            height: ogImage.height,
            alt: "Mesa Operacional SAMU",
        }],
    },
    twitter: {
        card: "summary_large_image",
        title: "Mesa Operacional SAMU",
        description: "Mesa operacional moderna para regulação, intervenção e comando de plantões SAMU",
        images: [ogImage.src],
    },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        // suppressHydrationWarning: o script de tema seta data-tema antes da
        // hidratação — divergência esperada e proposital neste atributo.
        <html lang="pt-BR" suppressHydrationWarning>
            <body className={`${manrope.variable} ${spaceGrotesk.variable} ${dmSans.variable} ${dmMono.variable}`}>
                <script dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }} />
                {children}
                <Toaster />
            </body>
        </html>
    );
}
