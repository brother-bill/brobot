import { Migration } from '@mikro-orm/migrations';

export class Migration20260927223759 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "command_setting" ("name" text not null, "enabled" boolean not null, "updated_by" text null, "updated_date" timestamptz not null, constraint "command_setting_pkey" primary key ("name"));`);

    this.addSql(`create table "pokemon_battle_outcome" ("id" uuid not null, "updated_date" timestamptz not null, "outcome" text[] not null default '{}', constraint "pokemon_battle_outcome_pkey" primary key ("id"));`);

    this.addSql(`create table "pokemon_team_battle_outcome" ("id" uuid not null, "updated_date" timestamptz not null, "outcome" text[] not null default '{}', constraint "pokemon_team_battle_outcome_pkey" primary key ("id"));`);

    this.addSql(`create table "twitch_user" ("oauth_id" text not null, "display_name" text not null, "created_date" timestamptz not null default now(), "roles" text[] not null default '{Viewer}', "updated_date" timestamptz not null, constraint "twitch_user_pkey" primary key ("oauth_id"));`);

    this.addSql(`create table "twitch_streamer_auth" ("id" uuid not null, "access_token" text not null, "refresh_token" text not null, "scope" text[] not null default '{}', "created_date" timestamptz not null default now(), "expiry_seconds" int not null, "user_oauth_id" text not null, "updated_date" timestamptz not null, "obtainment_epoch" bigint not null, constraint "twitch_streamer_auth_pkey" primary key ("id"));`);
    this.addSql(`alter table "twitch_streamer_auth" add constraint "twitch_streamer_auth_user_oauth_id_unique" unique ("user_oauth_id");`);

    this.addSql(`create table "twitch_bot_auth" ("id" uuid not null, "access_token" text not null, "refresh_token" text not null, "scope" text[] not null default '{}', "created_date" timestamptz not null default now(), "expiry_seconds" int not null, "user_oauth_id" text not null, "updated_date" timestamptz not null, "obtainment_epoch" bigint not null, constraint "twitch_bot_auth_pkey" primary key ("id"));`);
    this.addSql(`alter table "twitch_bot_auth" add constraint "twitch_bot_auth_user_oauth_id_unique" unique ("user_oauth_id");`);

    this.addSql(`create table "pokemon_team" ("id" uuid not null, "user_oauth_id" text not null, "created_date" timestamptz not null default now(), "updated_date" timestamptz not null, constraint "pokemon_team_pkey" primary key ("id"));`);
    this.addSql(`alter table "pokemon_team" add constraint "pokemon_team_user_oauth_id_unique" unique ("user_oauth_id");`);

    this.addSql(`create table "pokemon" ("id" uuid not null, "name" text not null, "name_id" text not null, "slot" int not null, "level" int not null default 1, "shiny" boolean not null, "wins" int not null default 0, "losses" int not null default 0, "draws" int not null default 0, "item" text not null default '', "moves" text[] not null default '{}', "dex_num" int not null, "color" text not null, "types" text[] not null default '{}', "gender" text not null, "nature" text not null, "ability" text not null, "team_id" uuid null, "user_oauth_id" text not null, "created_date" timestamptz not null default now(), "updated_date" timestamptz not null, "active_game" text check ("active_game" in ('brobot', 'pmd')) not null default 'brobot', "pmd_register_id" uuid null, "pmd_first_transferred_at" timestamptz null, "level_at_departure" int null, constraint "pokemon_pkey" primary key ("id"), constraint pokemon_slot_check check (slot between 1 and 6));`);
    this.addSql(`create index "pokemon_user_oauth_id_index" on "pokemon" ("user_oauth_id");`);
    this.addSql(`create index "pokemon_team_id_index" on "pokemon" ("team_id");`);
    this.addSql(`create index "pokemon_level_index" on "pokemon" ("level");`);

    this.addSql(`create table "transfer_log" ("id" bigserial primary key, "pokemon_id" uuid not null, "direction" text check ("direction" in ('depart', 'return')) not null, "nonce" text not null, "twitch_id" text not null, "pmd_register_id" uuid null, "level_before" int not null, "level_after" int not null, "at" timestamptz not null default now());`);
    this.addSql(`create index "transfer_log_pokemon_id_id_index" on "transfer_log" ("pokemon_id", "id");`);
    this.addSql(`alter table "transfer_log" add constraint "transfer_log_pokemon_direction_nonce_unique" unique ("pokemon_id", "direction", "nonce");`);

    this.addSql(`create table "twitch_user_registered" ("id" uuid not null, "user_oauth_id" text not null, "email" text null, "profile_image_url" text not null, "scope" text[] not null default '{}', "updated_date" timestamptz not null, "origin_date" timestamptz not null, "registered_date" timestamptz not null default now(), constraint "twitch_user_registered_pkey" primary key ("id"));`);
    this.addSql(`alter table "twitch_user_registered" add constraint "twitch_user_registered_user_oauth_id_unique" unique ("user_oauth_id");`);

    this.addSql(`alter table "twitch_streamer_auth" add constraint "twitch_streamer_auth_user_oauth_id_foreign" foreign key ("user_oauth_id") references "twitch_user" ("oauth_id") on update cascade on delete cascade;`);

    this.addSql(`alter table "twitch_bot_auth" add constraint "twitch_bot_auth_user_oauth_id_foreign" foreign key ("user_oauth_id") references "twitch_user" ("oauth_id") on update cascade on delete cascade;`);

    this.addSql(`alter table "pokemon_team" add constraint "pokemon_team_user_oauth_id_foreign" foreign key ("user_oauth_id") references "twitch_user" ("oauth_id") on update cascade on delete cascade;`);

    this.addSql(`alter table "pokemon" add constraint "pokemon_team_id_foreign" foreign key ("team_id") references "pokemon_team" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "pokemon" add constraint "pokemon_user_oauth_id_foreign" foreign key ("user_oauth_id") references "twitch_user" ("oauth_id") on update cascade on delete cascade;`);

    this.addSql(`alter table "transfer_log" add constraint "transfer_log_pokemon_id_foreign" foreign key ("pokemon_id") references "pokemon" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "twitch_user_registered" add constraint "twitch_user_registered_user_oauth_id_foreign" foreign key ("user_oauth_id") references "twitch_user" ("oauth_id") on update cascade on delete cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "twitch_streamer_auth" drop constraint "twitch_streamer_auth_user_oauth_id_foreign";`);

    this.addSql(`alter table "twitch_bot_auth" drop constraint "twitch_bot_auth_user_oauth_id_foreign";`);

    this.addSql(`alter table "pokemon_team" drop constraint "pokemon_team_user_oauth_id_foreign";`);

    this.addSql(`alter table "pokemon" drop constraint "pokemon_user_oauth_id_foreign";`);

    this.addSql(`alter table "twitch_user_registered" drop constraint "twitch_user_registered_user_oauth_id_foreign";`);

    this.addSql(`alter table "pokemon" drop constraint "pokemon_team_id_foreign";`);

    this.addSql(`alter table "transfer_log" drop constraint "transfer_log_pokemon_id_foreign";`);

    this.addSql(`drop table if exists "command_setting" cascade;`);

    this.addSql(`drop table if exists "pokemon_battle_outcome" cascade;`);

    this.addSql(`drop table if exists "pokemon_team_battle_outcome" cascade;`);

    this.addSql(`drop table if exists "twitch_user" cascade;`);

    this.addSql(`drop table if exists "twitch_streamer_auth" cascade;`);

    this.addSql(`drop table if exists "twitch_bot_auth" cascade;`);

    this.addSql(`drop table if exists "pokemon_team" cascade;`);

    this.addSql(`drop table if exists "pokemon" cascade;`);

    this.addSql(`drop table if exists "transfer_log" cascade;`);

    this.addSql(`drop table if exists "twitch_user_registered" cascade;`);
  }

}
