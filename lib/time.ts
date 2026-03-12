export function nowUtc() {
    return new Date();
}

export function toDate(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date value.");
    }
    return date;
}
