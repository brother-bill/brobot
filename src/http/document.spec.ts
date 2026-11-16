import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { JsonSchema, OpenApiDocument } from '@singularity/http-contract';
import { ThrottlerException } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthController, AuthRefreshAliasController } from '../modules/auth/auth.controller';
import { CommandsController } from '../modules/commands/commands.controller';
import { HealthController } from '../modules/health/health.controller';
import { PokemonController } from '../modules/pokemon/pokemon.controller';
import { TransferController } from '../modules/transfer/transfer.controller';
import { TRANSFER_ERROR_CODES } from '../modules/transfer/transfer-rules';
import { HorrorModeController } from '../modules/twitch/horror/horror-mode.controller';
import { BrobotError, BrobotTransferError, BrobotValidationError } from './common';
import { BrobotHealthResponse, BrobotLivenessResponse } from './health';
import { brobotDocument, routes } from './index';

const CONTROLLERS = [
    HealthController,
    AuthController,
    AuthRefreshAliasController,
    CommandsController,
    PokemonController,
    TransferController,
    HorrorModeController,
];

interface Served {
    key: string;
    status: number;
}

/** Every handler Nest serves, as `METHOD /path` (OpenAPI templates) with the status it answers by default. */
function servedRoutes(): Served[] {
    const served: Served[] = [];
    for (const controller of CONTROLLERS) {
        const base = String(Reflect.getMetadata(PATH_METADATA, controller));
        const prototype = controller.prototype as unknown as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
            const handler = prototype[name];
            if (name === 'constructor' || typeof handler !== 'function') continue;
            const method = Reflect.getMetadata(METHOD_METADATA, handler) as
                | RequestMethod
                | undefined;
            if (method === undefined) continue;
            const path = String(Reflect.getMetadata(PATH_METADATA, handler));
            const full = `/${[base, path]
                .filter(part => part !== '/' && part !== '')
                .join('/')}`.replace(/:(\w+)/g, '{$1}');
            const code = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
            served.push({
                key: `${RequestMethod[method]} ${full}`,
                status: code ?? (method === RequestMethod.POST ? 201 : 200),
            });
        }
    }
    return served;
}

function operations(document: OpenApiDocument) {
    return Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.entries(methods ?? {}).map(([method, operation]) => ({
            key: `${method.toUpperCase()} ${path}`,
            operation,
        })),
    );
}

/** The strings and arrays a request body can carry, each with what bounds it (the request-body-bounds rule). */
function unbounded(
    schema: JsonSchema,
    components: OpenApiDocument['components']['schemas'],
    at: string,
    seen = new Set<string>(),
): string[] {
    const ref = schema['$ref'];
    if (typeof ref === 'string') {
        const id = ref.replace('#/components/schemas/', '');
        if (seen.has(id)) return [];
        seen.add(id);
        return unbounded(components[id] ?? {}, components, id, seen);
    }
    const found: string[] = [];
    const types = ([] as unknown[]).concat(schema['type'] ?? []);
    const bounded =
        ['maxLength', 'enum', 'const', 'format'].some(key => key in schema) ||
        /^\^[^*+]*\$$/.test(String(schema['pattern'] ?? ''));
    if (types.includes('string') && !bounded) found.push(at);
    if (types.includes('array') && !('maxItems' in schema)) found.push(at);
    for (const [name, property] of Object.entries(
        (schema['properties'] ?? {}) as Record<string, JsonSchema>,
    )) {
        found.push(...unbounded(property, components, `${at}.${name}`, seen));
    }
    if (schema['items'] !== undefined)
        found.push(...unbounded(schema['items'] as JsonSchema, components, `${at}[]`, seen));
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
        for (const branch of (schema[key] ?? []) as JsonSchema[])
            found.push(...unbounded(branch, components, at, seen));
    }
    return found;
}

describe('brobotDocument()', () => {
    const document = brobotDocument();

    it('builds a complete OpenAPI 3.1 document of all 24 operations', () => {
        expect(document.openapi).toBe('3.1.0');
        expect(document.servers).toEqual([{ url: '/api', description: expect.any(String) }]);
        expect(document.security).toEqual([]);
        expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
            'bearerAuth',
            'cookieAuth',
            'serviceToken',
        ]);
        expect(document.components.securitySchemes['cookieAuth']).toMatchObject({
            type: 'apiKey',
            in: 'cookie',
            name: 'accessToken',
        });
        expect(operations(document)).toHaveLength(24);
        expect(Object.keys(routes)).toHaveLength(24);
    });

    it('is exactly what Nest serves: every handler an operation, at its default status', () => {
        const served = servedRoutes();
        expect(served.map(route => route.key).sort()).toEqual(
            operations(document)
                .map(op => op.key)
                .sort(),
        );
        for (const { key, status } of served) {
            const operation = operations(document).find(op => op.key === key)?.operation;
            const documented = Object.keys(operation?.responses ?? {});
            // A start route answers through `@Res()` with a redirect only, never Nest's default status.
            const redirectOnly =
                documented.includes('302') && !documented.some(code => code.startsWith('2'));
            expect(
                redirectOnly || documented.includes(String(status)),
                `${key} answers ${status}`,
            ).toBe(true);
        }
    });

    it('names every component for brobot', () => {
        const ids = Object.keys(document.components.schemas);
        expect(ids.length).toBeGreaterThan(20);
        expect(ids.filter(id => !id.startsWith('Brobot'))).toEqual([]);
    });

    it('keeps the transfer request bodies open to unknown fields and every other object strict', () => {
        const schemas = document.components.schemas;
        expect(schemas['BrobotDepartRequest']).not.toHaveProperty('additionalProperties');
        expect(schemas['BrobotReturnRequest']).not.toHaveProperty('additionalProperties');
        for (const id of [
            'BrobotSetCommandEnabledRequest',
            'BrobotRefreshRequest',
            'BrobotSetHorrorModeRequest',
            'BrobotTeamResponse',
            'BrobotError',
        ]) {
            expect(schemas[id], id).toMatchObject({ additionalProperties: false });
        }
    });

    it('bounds every string and array a request body can carry', () => {
        const bodies = operations(document).flatMap(({ key, operation }) =>
            Object.values(operation.requestBody?.content ?? {}).map(media => ({
                key,
                schema: media?.schema ?? {},
            })),
        );
        expect(bodies).toHaveLength(6);
        expect(
            bodies.flatMap(({ key, schema }) =>
                unbounded(schema, document.components.schemas, key),
            ),
        ).toEqual([]);
    });

    it('documents the redirects as 302, and the callbacks as 302 or JSON', () => {
        for (const id of ['twitchLogin', 'twitchStreamerLink', 'twitchBotLink'] as const) {
            expect(Object.keys(routes[id].responses)).toContain('302');
        }
        for (const id of [
            'twitchCallback',
            'twitchStreamerCallback',
            'twitchBotCallback',
        ] as const) {
            expect(Object.keys(routes[id].responses)).toEqual(
                expect.arrayContaining(['200', '302', '401', '403', '502']),
            );
        }
    });

    it('documents a refresh as 200 with the pair, and says cookie mode answers an empty 200', () => {
        for (const path of ['/auth/refresh', '/auth/twitch/refresh']) {
            const ok = document.paths[path]?.post?.responses['200'];
            expect(ok?.content?.['application/json']?.schema).toEqual({
                $ref: '#/components/schemas/BrobotTokenPair',
            });
            expect(ok?.description).toMatch(
                /Cookie\s+mode[\s\S]*answers `200` with an empty\s+body/,
            );
            expect(document.paths[path]?.post?.requestBody?.required).toBe(false);
        }
    });

    it("documents the horror POST's { mode: enum } body", () => {
        expect(document.components.schemas['BrobotSetHorrorModeRequest']).toMatchObject({
            properties: { mode: { $ref: '#/components/schemas/BrobotHorrorMode' } },
            required: ['mode'],
        });
        expect(document.components.schemas['BrobotHorrorMode']).toMatchObject({
            enum: ['off', 'rehearsal', 'live'],
        });
    });

    it('keeps the query-string transfer list and the pmdLevel spelling', () => {
        expect(document.paths['/internal/transfer/pokemon']?.get?.parameters).toEqual([
            expect.objectContaining({ name: 'twitchId', in: 'query', required: true }),
        ]);
        expect(document.components.schemas['BrobotReturnRequest']).toMatchObject({
            properties: { pmdLevel: expect.any(Object), level: expect.any(Object) },
        });
    });
});

describe('the error components describe what Nest sends', () => {
    it("BrobotError: Nest's body, with and without a message", () => {
        for (const exception of [
            new UnauthorizedException(),
            new UnauthorizedException('invalid_state'),
            new ForbiddenException(),
            new NotFoundException('No brobot user with that login'),
            new BadRequestException('mode must be one of off, rehearsal, live'),
        ]) {
            expect(BrobotError.safeParse(exception.getResponse()).success, exception.message).toBe(
                true,
            );
        }
        // The throttler's body is a string; Nest's filter sends it as { statusCode, message }.
        const throttled = new ThrottlerException();
        expect(
            BrobotError.safeParse({
                statusCode: throttled.getStatus(),
                message: throttled.getResponse(),
            }).success,
        ).toBe(true);
    });

    it("BrobotValidationError: the pipe's body", () => {
        const pipe = new ZodValidationPipe(routes.returnPokemon.body);
        let thrown: unknown;
        try {
            pipe.transform({ twitchId: 'x', nonce: '' });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(BadRequestException);
        const body = (thrown as BadRequestException).getResponse();
        expect(body).toMatchObject({ message: 'Validation failed' });
        expect(BrobotValidationError.parse(body).issues.length).toBeGreaterThan(0);
    });

    it("BrobotTransferError: the service's keyed body", () => {
        const keyed = new HttpException(
            {
                statusCode: 409,
                error: 'Conflict',
                code: TRANSFER_ERROR_CODES.teamFull,
                message: 'team full',
            },
            409,
        );
        expect(BrobotTransferError.safeParse(keyed.getResponse()).success).toBe(true);
        expect(
            BrobotTransferError.safeParse({
                statusCode: 409,
                error: 'Conflict',
                code: 'nope',
                message: 'x',
            }).success,
        ).toBe(false);
    });
});

describe('the health handlers answer their components', () => {
    it('getHealth and getLiveness', () => {
        const controller = new HealthController();
        expect(BrobotHealthResponse.parse(controller.health())).toEqual(controller.health());
        expect(BrobotLivenessResponse.safeParse(controller.live()).success).toBe(true);
    });
});
