import { markLoaded } from "../loaded.ts";
import { throwingAllowedGuard } from "../throws-allowed.ts";

markLoaded("throws-allowed");

export default throwingAllowedGuard.opencode();
