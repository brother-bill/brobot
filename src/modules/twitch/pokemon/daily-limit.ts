/**
 * A per-viewer count that resets at midnight in `timeZone` — the old bot's
 * "slaughter limit", cleared by a cron at 00:00 America/New_York.
 */
export class DailyLimit {
    private day = '';
    private readonly counts = new Map<string, number>();
    private readonly formatter: Intl.DateTimeFormat;

    constructor(
        readonly max: number,
        timeZone = 'America/New_York',
        private readonly now: () => Date = () => new Date(),
    ) {
        this.formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    isExhausted(key: string): boolean {
        return this.used(key) >= this.max;
    }

    used(key: string): number {
        this.rollOver();
        return this.counts.get(key) ?? 0;
    }

    record(key: string): void {
        this.rollOver();
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }

    private rollOver(): void {
        const today = this.formatter.format(this.now());
        if (today === this.day) return;
        this.day = today;
        this.counts.clear();
    }
}
