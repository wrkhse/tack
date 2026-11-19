let serial = 0;

function record(name, event) {
  return "probe-out/event-" + name + "-" + ++serial + ".json";
}

export const register = (on) => {
  for (const name of ["turn.start", "turn.step", "turn.complete", "session.start", "session.end", "tool.call", "tool.check", "session.append"]) {
    on(name, async ($, e, next) => {
      await $.fs.write(record(name.replaceAll(".", "-"), e), JSON.stringify(e));

      return next(e);
    });
  }
};
