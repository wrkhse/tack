import { markLoaded } from "../loaded.ts";

markLoaded("retry-veto");

/** Pi's sandbox disables retries, so this plugin has no native hook to add. */
export default () => {};
