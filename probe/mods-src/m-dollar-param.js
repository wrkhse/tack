export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const api = $;

    await api.fs.write("probe-out/dollar-param.json", JSON.stringify({ ok: true, input: e }));

    return next(e);
  });
};
