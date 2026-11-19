export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const fs = $.fs;

    await fs.write("probe-out/dollar-noun.json", JSON.stringify({ ok: true, input: e }));

    return next(e);
  });
};
