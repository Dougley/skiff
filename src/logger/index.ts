import { createConsola } from "consola";

function textualoggerLevel(level: string): number {
  switch (level.toLowerCase()) {
    case "fatal":
    case "error":
      return 0;
    case "warn":
    case "warning":
      return 1;
    case "info":
    case "information":
      return 3;
    case "debug":
      return 4;
    case "trace":
      return 5;
    case "silent":
      return -999;
    case "verbose":
      return 999;
    default: {
      const parsedLevel = parseInt(level, 10);
      if (!Number.isNaN(parsedLevel)) {
        return parsedLevel;
      }
      logger.warn(`Invalid log level "${level}", defaulting to "info" (3)`);
      return 3; // Default to 'info' level
    }
  }
}

const logger = createConsola({
  level: process.env.LOG_LEVEL ? textualoggerLevel(process.env.LOG_LEVEL) : 3,
});

export { logger };

export {
  align,
  box,
  centerAlign,
  colorize,
  colors,
  getColor,
  leftAlign,
  rightAlign,
  stripAnsi,
} from "consola/utils";
