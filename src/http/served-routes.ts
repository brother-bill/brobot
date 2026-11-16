/**
 * What brobot serves, read from the metadata Nest's decorators leave, in the
 * shared `served-routes/v1` format that singularity's checker compares with
 * the document (`libs/contracts/scripts/served-routes-check.mjs`; the format
 * is `libs/contracts/docs/publishing-a-contract.md` §4). Only specs read it:
 * `served-routes.spec.ts` boots the app, reads it, and runs the checker.
 *
 * brobot-local because brobot validates with `new ZodValidationPipe(schema)`
 * on each parameter, not with nestjs-zod DTO classes, so a query's names come
 * from the pipe's `schema` in `ROUTE_ARGS_METADATA`, not from a DTO type.
 *
 * Metadata says most of a route: method, path, the parameters each argument
 * decorator reads, `@HttpCode` (or Nest's default), and the guards. Two things
 * it cannot say are handed in per handler ({@link HandlerFacts}): the statuses
 * a handler or its services answer themselves, and the headers a handler
 * reads through `@Req()`. A handler that takes `@Req()`, or answers through
 * `@Res()`, without saying so fails the read rather than listing a guess.
 *
 * Not listed as headers: cookies (OpenAPI's `in: cookie`, which the format
 * has no slot for: `cookieAuth` and the refresh and OAuth state cookies), and
 * what app-wide middleware reads on every route (CORS's `Origin`, `trust
 * proxy`'s `X-Forwarded-For`): transport, not any operation's parameters.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import type { CanActivate, INestApplication, Type } from '@nestjs/common';
import {
    GUARDS_METADATA,
    HTTP_CODE_METADATA,
    METHOD_METADATA,
    PATH_METADATA,
    RESPONSE_PASSTHROUGH_METADATA,
    ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { APP_GUARD, ModulesContainer } from '@nestjs/core';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

export const SERVED_ROUTES_FORMAT = 'served-routes/v1';

/** One served route, as `served-routes/v1` has it. */
export interface ServedRoute {
    method: string;
    /** An OpenAPI template relative to the document's server URL (`/api`). */
    path: string;
    pathParams: string[];
    /** Null when the handler reads the raw query. */
    query: string[] | null;
    /** Lower case. */
    headers: string[];
    body: boolean;
    /** Every status the route sends, as `"200"`. */
    responses: string[];
    /** `Controller.handler`. */
    source: string;
}

export interface ServedRoutes {
    format: typeof SERVED_ROUTES_FORMAT;
    service: string;
    routes: ServedRoute[];
}

/** What a guard adds to every route it guards. */
export interface GuardFacts {
    /** The request headers it reads, lower case. */
    headers: readonly string[];
    /** The statuses it answers when it refuses. */
    refuses: readonly number[];
    /** Whether it guards this handler at all (a global guard a decorator switches off, as `@SkipThrottle` does). */
    guards?: (controller: Type, handler: object) => boolean;
}

/** What Nest's metadata cannot say about one handler. */
export interface HandlerFacts {
    /**
     * The statuses the handler, or a service it calls, answers itself: what
     * it throws, and everything it sends through `@Res()`. Required when it
     * takes `@Res()` without `passthrough`, since Nest's default status is then
     * never sent.
     */
    sends?: readonly number[];
    /** The headers it reads through `@Req()`, lower case. Required when it takes `@Req()`. */
    reads?: readonly string[];
}

export interface ServedRoutesOptions {
    service: string;
    controllers: readonly Type[];
    /** The app's global guards (`APP_GUARD`, `useGlobalGuards`). */
    globalGuards: readonly Type[];
    /** Every guard any route runs. A guard missing here fails the read. */
    guards: ReadonlyMap<Type, GuardFacts>;
    /** By `Controller.handler`. A key that names no handler fails the read. */
    handlers: Readonly<Record<string, HandlerFacts>>;
}

interface RouteArg {
    index: number;
    data?: unknown;
    pipes?: unknown[];
}

const join = (...parts: string[]) =>
    `/${parts
        .flatMap(part => part.split('/'))
        .filter(Boolean)
        .join('/')}`;
const template = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const templateNames = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
const paths = (value: unknown): string[] => ([] as unknown[]).concat(value ?? '/').map(String);
const sorted = <T extends string>(values: Iterable<T>) => [...new Set(values)].sort();

/** The property names of the object schema a `ZodValidationPipe` among `pipes` parses with, if any. */
function pipeKeys(pipes: readonly unknown[] | undefined): string[] | null {
    for (const pipe of pipes ?? []) {
        if (pipe instanceof ZodValidationPipe && pipe.schema instanceof z.ZodObject) {
            return Object.keys(pipe.schema.shape);
        }
    }
    return null;
}

const validates = (pipes: readonly unknown[] | undefined) =>
    (pipes ?? []).some(pipe => pipe instanceof ZodValidationPipe);

/** A guard in `@UseGuards` is a class or an instance. */
const guardClass = (guard: unknown): Type =>
    (typeof guard === 'function' ? guard : (guard as object).constructor) as Type;

export function servedRoutes(options: ServedRoutesOptions): ServedRoutes {
    const routes: ServedRoute[] = [];
    const factsUsed = new Set<string>();

    for (const controller of options.controllers) {
        const prototype = controller.prototype as Record<string, unknown>;
        const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];

        for (const name of Object.getOwnPropertyNames(prototype)) {
            const handler = prototype[name];
            if (name === 'constructor' || typeof handler !== 'function') continue;
            const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as
                | RequestMethod
                | undefined;
            if (methodCode === undefined) continue;

            const source = `${controller.name}.${name}`;
            const known = Object.hasOwn(options.handlers, source);
            if (known) factsUsed.add(source);
            const facts: HandlerFacts = known ? options.handlers[source] : {};
            const fail = (message: string): never => {
                throw new Error(`${source}: ${message}`);
            };

            const method = RequestMethod[methodCode];
            const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ??
                {}) as Record<string, RouteArg>;
            const pathParams: string[] = [];
            const headers: string[] = [];
            const statuses = new Set<number>();
            let query: string[] | null = [];
            let body = false;
            let takesReq = false;
            let takesRes = false;

            for (const [key, arg] of Object.entries(args)) {
                // Custom decorators (`@CurrentUser()`) key as `<id>__customRouteArgs__:<index>`: they read what a guard left.
                const kind = Number(key.split(':')[0]);
                if (validates(arg.pipes)) statuses.add(400);
                switch (kind) {
                    case RouteParamtypes.PARAM:
                        if (typeof arg.data === 'string') pathParams.push(arg.data);
                        else pathParams.push(...(pipeKeys(arg.pipes) ?? []));
                        break;
                    case RouteParamtypes.QUERY:
                        if (typeof arg.data === 'string')
                            query = query === null ? null : [...query, arg.data];
                        else {
                            const keys = pipeKeys(arg.pipes);
                            query = keys && query ? [...query, ...keys] : null;
                        }
                        break;
                    case RouteParamtypes.HEADERS:
                        if (typeof arg.data !== 'string')
                            fail('reads every header (`@Headers()`): name them');
                        headers.push(String(arg.data).toLowerCase());
                        break;
                    case RouteParamtypes.BODY:
                    case RouteParamtypes.RAW_BODY:
                        body = true;
                        break;
                    case RouteParamtypes.REQUEST:
                        takesReq = true;
                        break;
                    case RouteParamtypes.RESPONSE:
                        takesRes = true;
                        break;
                }
            }

            const passthrough =
                Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, name) === true;
            const answersItself = takesRes && !passthrough;
            if (takesReq && !facts.reads) fail('takes @Req(): list the headers it reads (`reads`)');
            if (answersItself && !facts.sends)
                fail('answers through @Res(): list every status it sends (`sends`)');

            if (!answersItself) {
                const code = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
                statuses.add(code ?? (methodCode === RequestMethod.POST ? 201 : 200));
            }
            for (const status of facts.sends ?? []) statuses.add(status);
            headers.push(...(facts.reads ?? []));

            const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
                []) as unknown[];
            for (const guard of [...options.globalGuards, ...classGuards, ...handlerGuards].map(
                guardClass,
            )) {
                const guardFacts =
                    options.guards.get(guard) ??
                    fail(`runs ${guard.name}, which the guard facts do not list`);
                if (guardFacts.guards && !guardFacts.guards(controller, handler)) continue;
                headers.push(...guardFacts.headers);
                for (const status of guardFacts.refuses) statuses.add(status);
            }

            for (const base of paths(Reflect.getMetadata(PATH_METADATA, controller))) {
                for (const path of paths(Reflect.getMetadata(PATH_METADATA, handler))) {
                    const full = template(join(base, path));
                    routes.push({
                        method,
                        path: full,
                        // A path parameter no decorator names is still in the URL: Nest matched it.
                        pathParams: sorted(pathParams.length ? pathParams : templateNames(full)),
                        query: query === null ? null : sorted(query),
                        headers: sorted(headers),
                        body,
                        responses: sorted([...statuses].map(String)),
                        source,
                    });
                }
            }
        }
    }

    const stale = Object.keys(options.handlers).filter(key => !factsUsed.has(key));
    if (stale.length) throw new Error(`handler facts name no served handler: ${stale.join(', ')}`);
    return { format: SERVED_ROUTES_FORMAT, service: options.service, routes };
}

/** Every controller the app registered, from each module, in registration order. */
export function appControllers(app: INestApplication): Type[] {
    const controllers: Type[] = [];
    for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.controllers.values()) {
            if (wrapper.metatype) controllers.push(wrapper.metatype as Type);
        }
    }
    return controllers;
}

/** The guards registered as `APP_GUARD` providers (Nest keys each `APP_GUARD (UUID: …)`). */
export function appGlobalGuards(app: INestApplication): Type<CanActivate>[] {
    const guards: Type<CanActivate>[] = [];
    for (const module of app.get(ModulesContainer).values()) {
        for (const [token, wrapper] of module.providers) {
            if (typeof token === 'string' && token.startsWith(APP_GUARD) && wrapper.metatype) {
                guards.push(wrapper.metatype as Type<CanActivate>);
            }
        }
    }
    return guards;
}
