import type { Metadata } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
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
        <html lang="pt-BR">
            <body className={`${manrope.variable} ${spaceGrotesk.variable}`}>
                {children}
                <Toaster />
            </body>
        </html>
    );
}
