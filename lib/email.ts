import nodemailer from "nodemailer";

/**
 * Envio de email transacional via SMTP do Gmail (App Password, não a senha da
 * conta). Envs: GMAIL_SMTP_USER (endereço) e GMAIL_SMTP_APP_PASSWORD; EMAIL_FROM
 * opcional muda só o display name. Sem envs configuradas, isEmailConfigured()
 * devolve false e os fluxos que dependem de email respondem 503 — nunca fingimos
 * que enviamos.
 */
function getSmtpConfig() {
    const user = process.env.GMAIL_SMTP_USER?.trim();
    const pass = process.env.GMAIL_SMTP_APP_PASSWORD?.trim();
    if (!user || !pass) {
        return null;
    }
    return { user, pass };
}

export function isEmailConfigured() {
    return getSmtpConfig() !== null;
}

let cachedTransporter: nodemailer.Transporter | null = null;

function getTransporter() {
    const config = getSmtpConfig();
    if (!config) {
        throw new Error("GMAIL_SMTP_USER/GMAIL_SMTP_APP_PASSWORD não configurados.");
    }
    if (!cachedTransporter) {
        cachedTransporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: config,
        });
    }
    return cachedTransporter;
}

export async function sendEmail(params: { to: string; subject: string; text: string }) {
    const config = getSmtpConfig();
    const from = process.env.EMAIL_FROM?.trim() || `Plantões SAMU <${config?.user}>`;
    await getTransporter().sendMail({
        from,
        to: params.to,
        subject: params.subject,
        text: params.text,
    });
}
