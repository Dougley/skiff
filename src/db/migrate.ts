import { migrate } from "drizzle-orm/pglite/migrator";
import { logger } from "../logger/index.js";
import { db } from "./index.js";

export async function runMigrations() {
  logger.info("Running database migrations...");

  await migrate(db, {
    migrationsFolder: "./drizzle/",
  });

  logger.info("Migrations complete.");
}
