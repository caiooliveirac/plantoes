import assert from "node:assert/strict";
import test from "node:test";
import {
    assertDoctorImportSafeToApply,
    normalizeDoctorName,
    parseDoctorImportFile,
    previewDoctorImportAgainstDirectory,
    summarizeDoctorImport,
} from "@/modules/doctors/importer";

test("normalizes doctor names consistently", () => {
    assert.equal(normalizeDoctorName("Ana Beatriz D'Almeida Silva"), "ANA BEATRIZ D'ALMEIDA SILVA");
    assert.equal(normalizeDoctorName("  Monica Aragao  "), "MONICA ARAGAO");
});

test("parses csv imports", () => {
    const rows = parseDoctorImportFile(
        "doctors.csv",
        [
            "full_name,display_name,external_code,aliases",
            "Ana Beatriz D'Almeida Silva,Ana Beatriz,crm-1,Ana Bia; Bia Almeida",
            "Monica Aragao,Monica,crm-2,Moni",
        ].join("\n"),
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0].fullName, "Ana Beatriz D'Almeida Silva");
    assert.equal(rows[1].displayName, "Monica");
    assert.equal(rows[0].aliases, "Ana Bia; Bia Almeida");
});

test("parses semicolon imports with alternate headers", () => {
    const rows = parseDoctorImportFile(
        "doctors.csv",
        [
            "NOME COMPLETO;APELIDO",
            "Luan Sampaio Evangelista Santos (Psiquiatria);Luan Sampaio (Psiquiatria)",
            "Maria Fernanda Souza Uzeda da SIlva;Maria Fernanda Uzeda",
        ].join("\n"),
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0].fullName, "Luan Sampaio Evangelista Santos (Psiquiatria)");
    assert.equal(rows[0].displayName, "Luan Sampaio (Psiquiatria)");
});

test("previewDoctorImportAgainstDirectory matches by full name and reports display changes and additions", () => {
    const preview = previewDoctorImportAgainstDirectory([
        {
            fullName: "Emily Thays Jardim Santos",
            displayName: "Emily Thays",
        },
        {
            fullName: "Ketherynne Cabral Ferrreira de Oliveira (Psiquiatria)",
            displayName: "Ketherynne Cabral (Psiquiatria)",
        },
    ], [
        {
            id: "1",
            fullName: "Emily Thays Jardim Santos",
            displayName: "Emily Santos",
            normalizedName: "EMILY SANTOS",
            externalCode: null,
            metadata: {},
            isActive: true,
        },
    ]);

    assert.equal(preview.total, 2);
    assert.deepEqual(preview.displayNameChanges, [
        {
            fullName: "Emily Thays Jardim Santos",
            previousDisplayName: "Emily Santos",
            nextDisplayName: "Emily Thays",
        },
    ]);
    assert.deepEqual(preview.normalizedNameFixes, [
        {
            fullName: "Emily Thays Jardim Santos",
            previousNormalizedName: "EMILY SANTOS",
            nextNormalizedName: "EMILY THAYS JARDIM SANTOS",
        },
    ]);
    assert.deepEqual(preview.additions, [
        {
            fullName: "Ketherynne Cabral Ferrreira de Oliveira",
            displayName: "Ketherynne Cabral",
            preferredOperationalRole: "PSIQ",
        },
    ]);
    assert.deepEqual(preview.riskyAdditions, []);
});

test("previewDoctorImportAgainstDirectory flags additions that collide with existing display names or aliases", () => {
    const preview = previewDoctorImportAgainstDirectory([
        {
            fullName: "Emily Thays Jardim Santos de Oliveira",
            displayName: "Emily Santos",
        },
    ], [
        {
            id: "1",
            fullName: "Emily Thays Jardim Santos",
            displayName: "Emily Santos",
            normalizedName: "EMILY SANTOS",
            externalCode: null,
            metadata: { aliases: ["Emily Thays"] },
            isActive: true,
        },
    ]);

    assert.equal(preview.additions.length, 1);
    assert.deepEqual(preview.riskyAdditions, [
        {
            fullName: "Emily Thays Jardim Santos de Oliveira",
            displayName: "Emily Santos",
            matchedDoctors: [
                {
                    id: "1",
                    fullName: "Emily Thays Jardim Santos",
                    displayName: "Emily Santos",
                    matchedBy: ["display_name", "legacy_normalized_name"],
                },
            ],
        },
    ]);
});

test("assertDoctorImportSafeToApply blocks risky additions and additions without explicit approval", () => {
    assert.throws(() => assertDoctorImportSafeToApply({
        total: 1,
        unchanged: 0,
        additions: [
            {
                fullName: "Novo Medico",
                displayName: "Novo",
                preferredOperationalRole: null,
            },
        ],
        riskyAdditions: [],
        displayNameChanges: [],
        normalizedNameFixes: [],
        preferredOperationalRoleChanges: [],
        aliasChanges: [],
    }), /new doctors would be created/i);

    assert.throws(() => assertDoctorImportSafeToApply({
        total: 1,
        unchanged: 0,
        additions: [
            {
                fullName: "Novo Medico",
                displayName: "Novo",
                preferredOperationalRole: null,
            },
        ],
        riskyAdditions: [
            {
                fullName: "Novo Medico",
                displayName: "Novo",
                matchedDoctors: [
                    {
                        id: "1",
                        fullName: "Medico Existente",
                        displayName: "Novo",
                        matchedBy: ["display_name"],
                    },
                ],
            },
        ],
        displayNameChanges: [],
        normalizedNameFixes: [],
        preferredOperationalRoleChanges: [],
        aliasChanges: [],
    }, { allowAdditions: true }), /risky additions/i);

    assert.doesNotThrow(() => assertDoctorImportSafeToApply({
        total: 1,
        unchanged: 0,
        additions: [
            {
                fullName: "Novo Medico",
                displayName: "Novo",
                preferredOperationalRole: null,
            },
        ],
        riskyAdditions: [],
        displayNameChanges: [],
        normalizedNameFixes: [],
        preferredOperationalRoleChanges: [],
        aliasChanges: [],
    }, { allowAdditions: true }));
});

test("summarizes duplicates and invalid rows", () => {
    const summary = summarizeDoctorImport([
        { fullName: "Ana Beatriz" },
        { fullName: "Ana Beatriz" },
        { fullName: "" },
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.duplicates.length, 1);
});
