import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * `@Body(new ZodValidationPipe(schema))` / `@Query(...)`: parse the value with
 * `schema` and hand the handler the parsed result, or answer 400 with every
 * issue.
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
    constructor(private readonly schema: T) {}

    transform(value: unknown): z.infer<T> {
        const result = this.schema.safeParse(value);
        if (!result.success) {
            throw new BadRequestException({
                message: 'Validation failed',
                issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
            });
        }
        return result.data;
    }
}
