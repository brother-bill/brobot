import { Injectable } from '@nestjs/common';

/**
 * Every roll the bot makes (species, shiny, catch odds, flavour lines) goes
 * through here, so a test can replace chance with a script.
 */
@Injectable()
export class Random {
    /** An integer in `[min, max]`, both ends included (the old `randomIntFromInterval`). */
    int(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    pick<T>(list: readonly T[]): T {
        if (list.length === 0) throw new Error('Cannot pick from an empty list');
        return list[this.int(0, list.length - 1)];
    }

    /** True with probability 1 in `n`. */
    oneIn(n: number): boolean {
        return this.int(1, n) <= 1;
    }
}
