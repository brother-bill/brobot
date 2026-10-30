import { Migration } from '@mikro-orm/migrations';

export class Migration20261030041659_AwayPokemonFreeSlot extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "pokemon" drop constraint pokemon_slot_check;`);

    this.addSql(`alter table "pokemon" alter column "slot" type int using ("slot"::int);`);
    this.addSql(`alter table "pokemon" alter column "slot" drop not null;`);
    // A Pokémon away in PMD holds no slot (owner decision, 2026-10-29): free the
    // slots of the ones already away, so the index below and the team rules
    // see the team as the Pokémon that are here. No-op on a fresh database.
    this.addSql(`update "pokemon" set "slot" = null where "active_game" = 'pmd';`);
    this.addSql(`create unique index "pokemon_team_id_slot_unique" on "pokemon" ("team_id", "slot") where "slot" is not null;`);
    this.addSql(`alter table "pokemon" add constraint pokemon_slot_check check(slot is null or slot between 1 and 6);`);
  }

  override async down(): Promise<void> {
    // The generator wrote `drop constraint`, but this is a partial index.
    this.addSql(`drop index "pokemon_team_id_slot_unique";`);
    this.addSql(`alter table "pokemon" drop constraint pokemon_slot_check;`);

    this.addSql(`alter table "pokemon" alter column "slot" type int4 using ("slot"::int4);`);
    // Away Pokémon have no slot to put back; `set not null` refuses while any
    // row is away. Bring them home (or give them a slot by hand) before a down.
    this.addSql(`alter table "pokemon" alter column "slot" set not null;`);
    this.addSql(`alter table "pokemon" add constraint pokemon_slot_check check((slot >= 1) AND (slot <= 6));`);
  }

}
