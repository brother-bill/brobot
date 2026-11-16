import { brobotDocument } from './document';

/** Path of the committed document, relative to the brobot root. */
export const OPENAPI_FILE = 'openapi.json';

/** The command that rewrites {@link OPENAPI_FILE}, run from apps/brobot. */
export const OPENAPI_COMMAND = 'pnpm run openapi';

/**
 * `brobotDocument()` as the committed `openapi.json`: OpenAPI 3.1, every
 * object's keys sorted (arrays keep their order), four-space indent, a final
 * newline. Sorting makes the file depend on what the routes say, not on the
 * order the builder or a route file happens to insert keys, so reordering a
 * route's fields leaves the file alone. openapi-document.spec.ts fails when
 * the committed file and this disagree.
 */
export function renderBrobotOpenApi(): string {
    return `${JSON.stringify(sortKeys(brobotDocument()), null, 4)}\n`;
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (typeof value !== 'object' || value === null) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(object)
            .sort()
            .map(key => [key, sortKeys(object[key])]),
    );
}
