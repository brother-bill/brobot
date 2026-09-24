import { Entity, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * A chat command's on/off switch as last set from the admin site or by a
 * channel-point redeem. Only commands somebody has switched have a row; the
 * rest run on their catalog default (`command-catalog.ts`). New in the
 * rebuild: the old bot held its one switch (`!quack`) in memory.
 */
@Entity({ tableName: 'command_setting' })
export class CommandSetting {
    [OptionalProps]?: 'updated_date' | 'updated_by';

    /** The catalog `name`, e.g. `pokemon-battle`. */
    @PrimaryKey({ type: 'text' })
    name!: string;

    @Property({ type: 'boolean' })
    enabled!: boolean;

    /** Who flipped it last: an admin's display name and id, or the redeem. */
    @Property({ type: 'text', nullable: true })
    updated_by?: string | null;

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();
}
