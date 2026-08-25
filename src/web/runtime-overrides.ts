import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";

export const runtimeLimitsSchema = z.object({
  maxAccountNotional: z.number().positive(),
  maxOrderNotional: z.number().positive(),
  maxOutcomePosition: z.number().positive(),
  maxTotalExposure: z.number().positive(),
  makerTargetReturnRate: z.number().positive().max(0.99),
  oddsStaleMs: z.number().int().positive(),
  repriceThresholdTicks: z.number().int().positive(),
});

export type RuntimeLimits = z.infer<typeof runtimeLimitsSchema>;

export function limitsFromConfig(config: AppConfig): RuntimeLimits {
  return {
    maxAccountNotional: config.MAX_ACCOUNT_NOTIONAL,
    maxOrderNotional: config.MAX_ORDER_NOTIONAL,
    maxOutcomePosition: config.MAX_OUTCOME_POSITION,
    maxTotalExposure: config.MAX_TOTAL_EXPOSURE,
    makerTargetReturnRate: config.MAKER_TARGET_RETURN_RATE,
    oddsStaleMs: config.ODDS_STALE_MS,
    repriceThresholdTicks: config.REPRICE_THRESHOLD_TICKS,
  };
}

export async function readRuntimeLimits(
  defaults: RuntimeLimits,
  path = "data/runtime-overrides.json",
): Promise<RuntimeLimits> {
  try {
    const parsed = runtimeLimitsSchema
      .partial()
      .parse(JSON.parse(await readFile(resolve(path), "utf8")));
    const defined = Object.fromEntries(
      Object.entries(parsed).filter((entry) => entry[1] !== undefined),
    );
    return runtimeLimitsSchema.parse({ ...defaults, ...defined });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
}

export async function writeRuntimeLimits(
  input: unknown,
  defaults: RuntimeLimits,
  path = "data/runtime-overrides.json",
): Promise<RuntimeLimits> {
  const limits = runtimeLimitsSchema.parse({ ...defaults, ...(input as object) });
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(limits, null, 2)}\n`, "utf8");
  await rename(temporaryPath, file);
  return limits;
}
