// ---------------------------------------------------------------------------
// Enforcement-mode resolver — pure module, no fs/network/SDK/process.env
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config";

export type EnforcementMode = "off" | "advisory" | "enforced";

export const DEFAULT_ENV_GATE = "MODEL_ROUTER_ENFORCE";

export function resolveEnforcementMode(args: {
  config: RouterConfig | undefined;
  tier?: string;
  env?: Record<string, string | undefined>;
}): { mode: EnforcementMode; warning?: string } {
  const enf = args.config?.enforcement;
  const gateName = enf?.envGate ?? DEFAULT_ENV_GATE;
  const raw = args.env?.[gateName];

  // Env gate overrides — highest priority
  if (raw === "1") {
    return { mode: "enforced" };
  }

  if (raw === "0") {
    return { mode: "off" };
  }

  // Unrecognized (non-empty, non-undefined) env value → fall through + warn
  let warning: string | undefined;
  if (raw !== undefined && raw !== "") {
    warning = `${gateName}="${raw}" is not "1" or "0"; ignoring env gate and using config.`;
  }

  // Config resolution
  const base: EnforcementMode = enf?.mode ?? "advisory";
  let mode: EnforcementMode;

  if (
    args.tier !== undefined &&
    enf?.perTier?.[args.tier] !== undefined
  ) {
    mode = enf.perTier[args.tier]!;
  } else {
    mode = base;
  }

  if (warning !== undefined) {
    return { mode, warning };
  }

  return { mode };
}
