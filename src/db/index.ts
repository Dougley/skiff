import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { env } from "../env/index.js";

const client = new PGlite({
  dataDir: env.DATABASE_URL,
  extensions: { vector },
});

const db = drizzle({ client });

export { db };

export * from "./schema.js";
