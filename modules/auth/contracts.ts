export const USER_ROLES = ["admin", "chief", "doctor"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
    return USER_ROLES.includes(value as UserRole);
}

export function requireRole(userRoles: string[], requiredRole: UserRole) {
    if (!userRoles.includes(requiredRole)) {
        throw new Error(`Missing required role: ${requiredRole}.`);
    }
}
