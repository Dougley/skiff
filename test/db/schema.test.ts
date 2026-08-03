import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

/**
 * schema.ts is only a description of the database — the tables themselves are
 * created by the SQL in drizzle/. These tests run both against the same PGlite
 * instance so a schema.ts change that never got a migration (or vice versa)
 * fails here instead of at runtime.
 */

type TableConfig = ReturnType<
  typeof import("drizzle-orm/pg-core").getTableConfig
>;

let tables: [string, TableConfig][];
let client: typeof import("../../src/db/index.js").client;
let schema: typeof import("../../src/db/schema.js");

async function query<T>(sql: string): Promise<T[]> {
  const result = await client.query<T>(sql);
  return result.rows;
}

beforeAll(async () => {
  const [{ runMigrations }, dbIndex, drizzle, pgCore] = await Promise.all([
    import("../../src/db/migrate.js"),
    import("../../src/db/index.js"),
    import("drizzle-orm"),
    import("drizzle-orm/pg-core"),
  ]);
  await runMigrations();
  client = dbIndex.client;
  schema = dbIndex;

  tables = Object.entries(schema)
    .filter(([, value]) => drizzle.is(value, drizzle.Table))
    // getTableConfig runs the `(t) => [...]` config callbacks, which is where
    // the index and constraint declarations actually get built
    .map(([name, value]) => [
      name,
      pgCore.getTableConfig(value as never),
    ]) satisfies [string, TableConfig][];
});

test("schema.ts declares a non-trivial set of tables", () => {
  assert.ok(tables.length >= 15, `only found ${tables.length} tables`);
  const names = tables.map(([, config]) => config.name);
  assert.equal(new Set(names).size, names.length, "duplicate table names");
});

test("every declared table and column exists in the migrated database", async () => {
  const dbColumns = await query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(
    `select table_name, column_name, is_nullable
     from information_schema.columns
     where table_schema = 'public'`
  );

  const byTable = new Map<string, Map<string, boolean>>();
  for (const row of dbColumns) {
    let columns = byTable.get(row.table_name);
    if (!columns) {
      columns = new Map();
      byTable.set(row.table_name, columns);
    }
    columns.set(row.column_name, row.is_nullable === "NO");
  }

  for (const [exportName, config] of tables) {
    const actual = byTable.get(config.name);
    assert.ok(
      actual,
      `table ${config.name} (export ${exportName}) not migrated`
    );

    for (const column of config.columns) {
      assert.ok(
        actual.has(column.name),
        `${config.name}.${column.name} is declared but not migrated`
      );
      assert.equal(
        actual.get(column.name),
        column.notNull,
        `${config.name}.${column.name} nullability differs from the migration`
      );
    }

    assert.deepEqual(
      [...actual.keys()].sort(),
      config.columns.map((c) => c.name).sort(),
      `${config.name} has columns in the database that schema.ts does not declare`
    );
  }
});

test("every declared index and unique constraint exists in the migrated database", async () => {
  const indexNames = new Set(
    (
      await query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public'"
      )
    ).map((row) => row.indexname)
  );

  let declared = 0;
  for (const [, config] of tables) {
    for (const index of config.indexes) {
      declared++;
      const name = index.config.name;
      assert.ok(name, `an index on ${config.name} is declared without a name`);
      assert.ok(
        indexNames.has(name),
        `index ${name} on ${config.name} is declared but not migrated`
      );
    }
    for (const unique of config.uniqueConstraints) {
      declared++;
      const name = unique.name;
      assert.ok(
        name,
        `a unique constraint on ${config.name} is declared without a name`
      );
      assert.ok(
        indexNames.has(name),
        `unique constraint ${name} on ${config.name} is declared but not migrated`
      );
    }
  }
  assert.ok(declared > 25, `only checked ${declared} indexes`);
});

test("every declared foreign key matches a constraint in the database", async () => {
  const { getTableName } = await import("drizzle-orm");

  const dbForeignKeys = new Set(
    (
      await query<{
        table_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }>(
        `select tc.table_name,
                kcu.column_name,
                ccu.table_name as foreign_table_name,
                ccu.column_name as foreign_column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
         where tc.constraint_type = 'FOREIGN KEY'
           and tc.table_schema = 'public'`
      )
    ).map(
      (row) =>
        `${row.table_name}.${row.column_name}->${row.foreign_table_name}.${row.foreign_column_name}`
    )
  );

  let declared = 0;
  for (const [, config] of tables) {
    for (const foreignKey of config.foreignKeys) {
      // reference() resolves the `() => otherTable.column` thunks, which is
      // what keeps circular table references working at module load
      const reference = foreignKey.reference();
      const foreignTable = getTableName(reference.foreignTable);
      for (const [i, column] of reference.columns.entries()) {
        const foreignColumn = reference.foreignColumns[i];
        assert.ok(foreignColumn, "foreign key column count mismatch");
        declared++;
        assert.ok(
          dbForeignKeys.has(
            `${config.name}.${column.name}->${foreignTable}.${foreignColumn.name}`
          ),
          `${config.name}.${column.name} -> ${foreignTable}.${foreignColumn.name} is declared but not migrated`
        );
      }
      assert.ok(
        ["cascade", "set null"].includes(foreignKey.onDelete ?? ""),
        `${config.name}.${reference.columns[0]?.name} has no delete behaviour`
      );
    }
  }
  assert.ok(declared >= 10, `only checked ${declared} foreign keys`);
});

test("the conversations channel/guild unique index treats null guilds as equal", async () => {
  const conversations = tables.find(
    ([, config]) => config.name === "conversations"
  );
  assert.ok(conversations);

  const unique = conversations[1].uniqueConstraints.find(
    (u) => u.name === "idx_conversations_channel_guild"
  );
  assert.ok(unique);
  // queries.ts relies on this: a DM (null guild) upsert must collide with the
  // existing DM row rather than silently inserting a duplicate conversation
  assert.equal(unique.nullsNotDistinct, true);

  const { db } = await import("../../src/db/index.js");
  const first = await db
    .insert(schema.conversations)
    .values({ channelId: "schema-null-guild", guildId: null, model: "m" })
    .returning();
  const second = await db
    .insert(schema.conversations)
    .values({ channelId: "schema-null-guild", guildId: null, model: "m" })
    .onConflictDoUpdate({
      target: [schema.conversations.channelId, schema.conversations.guildId],
      set: { model: "m2" },
    })
    .returning();

  assert.equal(second[0]?.id, first[0]?.id);
  assert.equal(second[0]?.model, "m2");
});

test("array and boolean column defaults come back as declared", async () => {
  const { db } = await import("../../src/db/index.js");

  const [storyline] = await db
    .insert(schema.storylines)
    .values({
      title: "defaults",
      goal: "check column defaults",
      currentState: "new",
    })
    .returning();

  assert.ok(storyline);
  assert.equal(storyline.status, "open");
  assert.deepEqual(storyline.tags, []);
  assert.deepEqual(storyline.ownerUserIds, []);
  assert.ok(storyline.lastActivityAt instanceof Date);

  const [settings] = await db
    .insert(schema.sleepCycleSettings)
    .values({ guildId: "schema-guild" })
    .returning();

  assert.ok(settings);
  assert.equal(settings.enabled, false);
  assert.equal(settings.dryRun, true);
  assert.equal(settings.autoAuthorSkills, false);
  assert.equal(settings.lowActivityMinutes, 60);
  assert.equal(settings.minInactiveMessages, 3);
  assert.equal(settings.maxRunsPerDay, 2);
});
