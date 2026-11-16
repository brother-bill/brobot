import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brobotDocument } from './document';
import { OPENAPI_COMMAND, OPENAPI_FILE, renderBrobotOpenApi } from './openapi-document';

describe('openapi.json', () => {
    const committed = readFileSync(join(__dirname, '../..', OPENAPI_FILE), 'utf8');

    it(`matches src/http/ — run \`${OPENAPI_COMMAND}\` in apps/brobot and commit the result`, () => {
        expect(
            committed,
            `${OPENAPI_FILE} is stale: run \`${OPENAPI_COMMAND}\` in apps/brobot and commit the result`,
        ).toBe(renderBrobotOpenApi());
    });

    it('is brobotDocument() as OpenAPI 3.1, keys sorted, ending with a newline', () => {
        const parsed = JSON.parse(committed) as Record<string, unknown>;
        expect(parsed).toEqual(brobotDocument());
        expect(parsed['openapi']).toBe('3.1.0');
        expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
        expect(committed.endsWith('}\n')).toBe(true);
    });
});
