const MIN_PASSWORD_LENGTH = 10;

export function getPasswordPolicyError(password: string, currentPassword?: string | null) {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `A nova senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    }

    const checks = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
    if (checks < 3) {
        return "A nova senha precisa combinar pelo menos tres grupos: letra minuscula, letra maiuscula, numero e simbolo.";
    }

    if (currentPassword && password === currentPassword) {
        return "A nova senha precisa ser diferente da senha atual.";
    }

    return null;
}

export function isPasswordPolicySatisfied(password: string, currentPassword?: string | null) {
    return getPasswordPolicyError(password, currentPassword) === null;
}