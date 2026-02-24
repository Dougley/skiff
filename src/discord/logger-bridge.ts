import {
  LogLevel,
  Plugin,
  preGenericsInitialization,
  SapphireClient,
} from "@sapphire/framework";
import type { ClientOptions } from "discord.js";
import { logger } from "../logger/index.js";

export class LoggerBridgePlugin extends Plugin {
  public static override [preGenericsInitialization](
    this: SapphireClient,
    options: ClientOptions
  ): void {
    options.logger ??= {};

    options.logger.instance = {
      has() {
        return true;
      },
      trace(...values: unknown[]) {
        logger.trace(...(values as [unknown, ...unknown[]]));
      },
      debug(...values: unknown[]) {
        logger.debug(...(values as [unknown, ...unknown[]]));
      },
      info(...values: unknown[]) {
        logger.info(...(values as [unknown, ...unknown[]]));
      },
      warn(...values: unknown[]) {
        logger.warn(...(values as [unknown, ...unknown[]]));
      },
      error(...values: unknown[]) {
        logger.error(...(values as [unknown, ...unknown[]]));
      },
      fatal(...values: unknown[]) {
        logger.fatal(...(values as [unknown, ...unknown[]]));
      },
      write(level, ...values) {
        switch (level) {
          case LogLevel.Trace:
            this.trace(...values);
            break;
          case LogLevel.Debug:
            this.debug(...values);
            break;
          case LogLevel.Info:
            this.info(...values);
            break;
          case LogLevel.Warn:
            this.warn(...values);
            break;
          case LogLevel.Error:
            this.error(...values);
            break;
          case LogLevel.Fatal:
            this.fatal(...values);
            break;
        }
      },
    };
  }
}

SapphireClient.plugins.registerPreGenericsInitializationHook(
  LoggerBridgePlugin[preGenericsInitialization],
  "Logger-PreGenericsInitialization"
);
