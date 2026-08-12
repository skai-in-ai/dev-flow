import { DEFAULT_WORKSPACE_ROOT, SystemOnboardingAdapter, onboardRepository } from "./repository-onboarding.js";

function usage(): never { throw new Error("用法：bin/dev-flow-onboard [--dry-run] [--workspace-root <absolute-path>] [--plist <absolute-path>] <absolute-checkout>"); }
const values = process.argv.slice(2);
let dryRun = false;
let workspaceRoot = process.env.DEV_FLOW_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT;
let plistPath: string | undefined;
let checkout: string | undefined;
for (let index = 0; index < values.length; index += 1) {
  const value = values[index];
  if (value === "--dry-run") { dryRun = true; continue; }
  if (value === "--workspace-root") { workspaceRoot = values[++index] ?? usage(); continue; }
  if (value === "--plist") { plistPath = values[++index] ?? usage(); continue; }
  if (value.startsWith("-")) usage();
  if (checkout !== undefined) usage();
  checkout = value;
}
if (!checkout || !checkout.startsWith("/")) usage();
const result = await onboardRepository(new SystemOnboardingAdapter(), { checkout, workspaceRoot, plistPath, dryRun });
console.log(JSON.stringify(result, null, 2));
