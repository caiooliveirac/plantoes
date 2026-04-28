"use client";

import { useDeferredValue, useEffectEvent, useState } from "react";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";

interface DoctorOption {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface ChiefAssignment {
    id: string;
    email: string;
    isActive: boolean;
    mustChangePassword: boolean;
    doctorId: string | null;
    fullName: string | null;
    displayName: string | null;
}

interface Props {
    doctors: DoctorOption[];
    assignments: ChiefAssignment[];
}

interface BootstrapResponse {
    assignment?: ChiefAssignment & { wasExistingUser?: boolean };
    error?: string;
}

function normalizeSearch(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function sortAssignments(assignments: ChiefAssignment[]) {
    return [...assignments].sort((left, right) => {
        if (left.mustChangePassword !== right.mustChangePassword) {
            return Number(right.mustChangePassword) - Number(left.mustChangePassword);
        }

        const leftName = left.displayName ?? left.fullName ?? left.email;
        const rightName = right.displayName ?? right.fullName ?? right.email;
        return leftName.localeCompare(rightName, "pt-BR");
    });
}

function pickRandom(characters: string) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return characters[values[0] % characters.length] ?? characters[0] ?? "A";
}

function generateTemporaryPassword() {
    const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lowercase = "abcdefghijkmnopqrstuvwxyz";
    const digits = "23456789";
    const symbols = "!@#$%&*";
    const all = `${uppercase}${lowercase}${digits}${symbols}`;
    const password = [
        pickRandom(uppercase),
        pickRandom(lowercase),
        pickRandom(digits),
        pickRandom(symbols),
    ];

    while (password.length < 14) {
        password.push(pickRandom(all));
    }

    for (let index = password.length - 1; index > 0; index -= 1) {
        const values = new Uint32Array(1);
        crypto.getRandomValues(values);
        const swapIndex = values[0] % (index + 1);
        [password[index], password[swapIndex]] = [password[swapIndex] as string, password[index] as string];
    }

    return password.join("");
}

function resolveAssignmentStateLabel(assignment: ChiefAssignment) {
    if (!assignment.isActive) {
        return "Inativo";
    }

    return assignment.mustChangePassword ? "Troca obrigatória" : "Operação liberada";
}

function resolveAssignmentTone(assignment: ChiefAssignment) {
    if (!assignment.isActive) {
        return "inactive";
    }

    return assignment.mustChangePassword ? "warning" : "ready";
}

export function ChiefAccessClient({ doctors, assignments: initialAssignments }: Props) {
    const [assignments, setAssignments] = useState(() => sortAssignments(initialAssignments));
    const [doctorSearch, setDoctorSearch] = useState("");
    const deferredDoctorSearch = useDeferredValue(doctorSearch);
    const [selectedDoctorId, setSelectedDoctorId] = useState("");
    const [email, setEmail] = useState("");
    const [temporaryPassword, setTemporaryPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const normalizedDoctorSearch = normalizeSearch(deferredDoctorSearch);
    const visibleDoctors = (normalizedDoctorSearch
        ? doctors.filter((doctor) => normalizeSearch(`${doctor.fullName} ${doctor.displayName ?? ""}`).includes(normalizedDoctorSearch))
        : doctors).slice(0, 8);
    const selectedDoctor = doctors.find((doctor) => doctor.id === selectedDoctorId) ?? null;
    const activeCount = assignments.filter((assignment) => assignment.isActive).length;
    const mustRotateCount = assignments.filter((assignment) => assignment.isActive && assignment.mustChangePassword).length;
    const readyCount = assignments.filter((assignment) => assignment.isActive && !assignment.mustChangePassword).length;

    const submitBootstrap = useEffectEvent(async () => {
        setErrorMessage(null);
        setSuccessMessage(null);
        setIsSubmitting(true);

        try {
            const response = await fetch("/api/chief/bootstrap", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    doctorId: selectedDoctorId,
                    email,
                    temporaryPassword,
                }),
            });

            const body = await response.json().catch(() => null) as BootstrapResponse | null;
            if (!response.ok || !body?.assignment) {
                throw new Error(body?.error || "Falha ao provisionar o acesso chief.");
            }

            setAssignments((current) => sortAssignments([
                ...current.filter((assignment) => assignment.id !== body.assignment?.id),
                body.assignment as ChiefAssignment,
            ]));

            setSuccessMessage(
                body.assignment.wasExistingUser
                    ? `Senha temporária renovada para ${body.assignment.email}. A chefia precisa entrar no quadro e trocar a senha antes de operar.`
                    : `Acesso chief criado para ${body.assignment.email}. O primeiro login acontece no quadro e exige troca da senha temporária.`,
            );
            setTemporaryPassword("");
        } finally {
            setIsSubmitting(false);
        }
    });

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        try {
            await submitBootstrap();
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha ao provisionar o acesso chief.");
        }
    }

    function handleGeneratePassword() {
        setTemporaryPassword(generateTemporaryPassword());
        setErrorMessage(null);
        setSuccessMessage(null);
    }

    return (
        <main className="chief-access-shell">
            <section className="chief-access-hero">
                <div>
                    <p className="reports-kicker">Acesso de chefia</p>
                    <h1>Crie login operacional do chief com senha temporária e liberação imediata no quadro.</h1>
                    <p className="chief-access-subtitle">
                        O bootstrap nasce bloqueado para operar. Assim que a chefia entra em / e troca a senha temporária, o perfil já pode ativar base, corrigir médico e função e editar almoço, descanso, jantar e trabalho.
                    </p>
                </div>

                <AdminGlobalNavigationLinks current="chief-access" containerClassName="chief-access-hero-actions" />
            </section>

            <section className="chief-access-summary-grid">
                <article className="chief-access-summary-card">
                    <span className="reports-summary-label">Chiefs ativos</span>
                    <strong>{activeCount}</strong>
                    <span>Perfis com login operacional ligado ao quadro.</span>
                </article>
                <article className="chief-access-summary-card warning">
                    <span className="reports-summary-label">Troca obrigatória</span>
                    <strong>{mustRotateCount}</strong>
                    <span>Perfis ainda bloqueados até a primeira troca de senha.</span>
                </article>
                <article className="chief-access-summary-card ready">
                    <span className="reports-summary-label">Operação liberada</span>
                    <strong>{readyCount}</strong>
                    <span>Chiefs já aptos a editar quadro e meal break.</span>
                </article>
            </section>

            <section className="chief-access-grid">
                <section className="chief-access-panel">
                    <div className="chief-access-panel-heading">
                        <div>
                            <p className="reports-kicker">Bootstrap</p>
                            <h2>Novo chief para o turno</h2>
                        </div>
                        <span className="chief-access-panel-badge">Admin only</span>
                    </div>

                    <p className="chief-access-panel-copy">
                        Use email individual. A senha temporária precisa ser forte e só serve para o primeiro login.
                    </p>

                    <form className="chief-access-form" onSubmit={handleSubmit}>
                        <label className="chief-access-field">
                            <span>Buscar médico</span>
                            <input
                                type="search"
                                value={doctorSearch}
                                onChange={(event) => setDoctorSearch(event.target.value)}
                                placeholder="Digite nome ou nome de exibição"
                            />
                        </label>

                        <div className="chief-access-doctor-list" role="listbox" aria-label="Diretório de médicos para provisionar chief">
                            {visibleDoctors.length === 0 ? (
                                <div className="chief-access-inline-empty">Nenhum médico encontrado no diretório ativo.</div>
                            ) : visibleDoctors.map((doctor) => {
                                const selected = doctor.id === selectedDoctorId;
                                return (
                                    <button
                                        key={doctor.id}
                                        type="button"
                                        className={`chief-access-doctor-option ${selected ? "selected" : ""}`.trim()}
                                        onClick={() => setSelectedDoctorId(doctor.id)}
                                    >
                                        <strong>{doctor.displayName ?? doctor.fullName}</strong>
                                        <span>{doctor.fullName}</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className={`chief-access-selected-doctor ${selectedDoctor ? "visible" : ""}`.trim()}>
                            {selectedDoctor ? `Selecionado: ${selectedDoctor.displayName ?? selectedDoctor.fullName}` : "Selecione o médico que vai operar como chief."}
                        </div>

                        <label className="chief-access-field">
                            <span>Email de login</span>
                            <input
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder="chief@dominio.com"
                                autoComplete="username"
                            />
                        </label>

                        <label className="chief-access-field">
                            <span>Senha temporária</span>
                            <div className="chief-access-password-row">
                                <input
                                    type="text"
                                    value={temporaryPassword}
                                    onChange={(event) => setTemporaryPassword(event.target.value)}
                                    placeholder="Mínimo de 10 caracteres com combinação forte"
                                    autoComplete="off"
                                />
                                <button type="button" className="chief-access-secondary-button" onClick={handleGeneratePassword}>
                                    Gerar
                                </button>
                            </div>
                        </label>

                        <div className="chief-access-inline-note">
                            Primeiro login: o chief entra em /, usa email e senha temporária e o próprio quadro pede a troca antes de liberar qualquer ação.
                        </div>

                        {(errorMessage || successMessage) && (
                            <div className={`chief-access-flash ${errorMessage ? "error" : "success"}`.trim()}>
                                {errorMessage ?? successMessage}
                            </div>
                        )}

                        <div className="chief-access-form-actions">
                            <button
                                type="submit"
                                className="chief-access-primary-button"
                                disabled={isSubmitting || !selectedDoctorId || !email.trim() || !temporaryPassword.trim()}
                            >
                                {isSubmitting ? "Provisionando..." : "Criar acesso chief"}
                            </button>
                        </div>
                    </form>
                </section>

                <section className="chief-access-panel roster">
                    <div className="chief-access-panel-heading">
                        <div>
                            <p className="reports-kicker">Acessos ativos</p>
                            <h2>Quem já consegue entrar</h2>
                        </div>
                        <span className="chief-access-panel-badge">{assignments.length} perfis</span>
                    </div>

                    <div className="chief-access-assignment-list">
                        {assignments.length === 0 ? (
                            <article className="chief-access-empty-state">
                                <strong>Nenhum chief provisionado.</strong>
                                <span>Crie o primeiro acesso usando o formulário ao lado.</span>
                            </article>
                        ) : assignments.map((assignment) => (
                            <article key={assignment.id} className="chief-access-assignment-card">
                                <div className="chief-access-assignment-topline">
                                    <span className={`chief-access-state-pill ${resolveAssignmentTone(assignment)}`.trim()}>
                                        {resolveAssignmentStateLabel(assignment)}
                                    </span>
                                    <span className="chief-access-state-meta">/</span>
                                </div>

                                <div className="chief-access-assignment-copy">
                                    <strong>{assignment.displayName ?? assignment.fullName ?? "Médico sem vínculo"}</strong>
                                    <span>{assignment.fullName ?? assignment.email}</span>
                                    <small>{assignment.email}</small>
                                </div>

                                <p className="chief-access-assignment-note">
                                    {assignment.mustChangePassword
                                        ? "Ainda bloqueado para operar até concluir a troca da senha temporária no quadro."
                                        : "Já pode operar base, médico, função e meal break diretamente no quadro."}
                                </p>
                            </article>
                        ))}
                    </div>
                </section>
            </section>
        </main>
    );
}