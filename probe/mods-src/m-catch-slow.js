async function guard($) {
  await $.clock.sleep(9500);

  return { deny: "slow guard answered" };
}

export const register = (on) => {
  on("tool.call", { tool: "Bash" }, guard).catch(async ($, e, next) => {
    await $.fs.write("probe-out/catch-slow.json", JSON.stringify({ called: next.called, error: next.error }));

    if (next.called) return next(e);

    return { deny: "probe slow guard failed: " + next.error.kind };
  });
};
