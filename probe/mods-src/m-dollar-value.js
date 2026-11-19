function writeIt(api, text) {
  return api.fs.write("probe-out/dollar-value.json", text);
}

export const register = (on) => {
  on("session.start", async ($, e, next) => {
    await writeIt($, JSON.stringify({ ok: true, input: e }));

    return next(e);
  });
};
