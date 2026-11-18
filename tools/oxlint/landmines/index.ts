import { definePlugin } from "vite-plus/lint/plugins";

import { noFixedSleep } from "./rules/no-fixed-sleep.ts";
import { noFlakeMasking } from "./rules/no-flake-masking.ts";
import { noUnsignaledPoll } from "./rules/no-unsignaled-poll.ts";

const plugin = definePlugin({
  meta: { name: "landmines-testing" },
  rules: {
    "no-fixed-sleep": noFixedSleep,
    "no-flake-masking": noFlakeMasking,
    "no-unsignaled-poll": noUnsignaledPoll,
  },
});

export default plugin;
