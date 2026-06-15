import assert from "node:assert/strict";
import test from "node:test";
import { validateDoctorDirectoryInput, validateDoctorDirectoryUpdateInput } from "@/modules/doctors/service";

test("validateDoctorDirectoryInput trims and normalizes directory fields", () => {
    const parsed = validateDoctorDirectoryInput({
        fullName: "  Ana Beatriz D'Almeida Silva  ",
        displayName: " Ana Beatriz ",
        externalCode: " crm-1 ",
        aliases: "Ana Bia, Bia Almeida, Ana Bia",
    });

    assert.deepEqual(parsed, {
        fullName: "Ana Beatriz D'Almeida Silva",
        displayName: "Ana Beatriz",
        externalCode: "crm-1",
        aliases: ["Ana Bia", "Bia Almeida"],
        normalizedName: "ANA BEATRIZ D'ALMEIDA SILVA",
    });
});

test("validateDoctorDirectoryUpdateInput preserves omitted trailing fields and normalizes aliases", () => {
    const parsed = validateDoctorDirectoryUpdateInput({
        lookup: " ana beatriz ",
        fullName: " Ana Beatriz D'Almeida Silva ",
        aliases: "Ana Bia, Bia Almeida, Ana Bia",
        hasAliases: true,
    });

    assert.deepEqual(parsed, {
        lookup: "ana beatriz",
        fullName: "Ana Beatriz D'Almeida Silva",
        normalizedName: "ANA BEATRIZ D'ALMEIDA SILVA",
        displayName: undefined,
        externalCode: undefined,
        aliases: ["Ana Bia", "Bia Almeida"],
        hasDisplayName: false,
        hasExternalCode: false,
        hasAliases: true,
    });
});

test("validateDoctorDirectoryInput rejects names without usable letters", () => {
    assert.throws(
        () => validateDoctorDirectoryInput({ fullName: "---" }),
        /Nome completo do medico invalido/,
    );
});