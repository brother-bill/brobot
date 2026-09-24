/** Records what `applyImport` asks of MikroORM. */
export class RecordingEntityManager {
    readonly upserts: {
        entity: string;
        rows: Record<string, unknown>[];
        options: Record<string, unknown>;
    }[] = [];
    transactions = 0;
    clears = 0;
    failOn: string | null = null;

    fork(): this {
        return this;
    }

    async transactional<T>(work: (em: this) => Promise<T>): Promise<T> {
        this.transactions++;
        return work(this);
    }

    async upsertMany(
        entity: { name: string },
        rows: Record<string, unknown>[],
        options: Record<string, unknown>,
    ) {
        if (this.failOn === entity.name) throw new Error(`boom in ${entity.name}`);
        this.upserts.push({ entity: entity.name, rows, options });
        return rows;
    }

    clear(): void {
        this.clears++;
    }

    getConnection() {
        return { execute: async () => [{ count: '0' }] };
    }
}
