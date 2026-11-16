/**
 * The request shapes of `/api/internal/transfer`. Their one copy is the route
 * definitions' (`src/http/transfer.ts`), which the controller validates
 * with; this re-export keeps the service's and the specs' imports.
 */
export {
    departBodySchema,
    pokemonIdParamSchema,
    returnBodySchema,
    twitchIdQuerySchema,
    twitchIdSchema,
} from '../../http/transfer';
export type { DepartBody, ReturnBody } from '../../http/transfer';
