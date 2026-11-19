import { Duration, Effect } from "effect";

function note(out, key, value) {
  out.push(key + "=" + value);
  return out;
}

export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const out = [];

    note(out, "globals.setTimeout", typeof setTimeout);
    note(out, "globals.queueMicrotask", typeof queueMicrotask);
    note(out, "globals.MessageChannel", typeof MessageChannel);
    note(out, "globals.console", typeof console);

    try {
      const value = await Effect.runPromise(Effect.succeed(42));
      note(out, "succeed", value);
    } catch (err) {
      note(out, "succeed-error", String(err));
    }

    await $.fs.write("probe-out/effect-before-shim.json", JSON.stringify({ out, input: e }));

    globalThis.setTimeout = (fn, ms) => $.clock.after(ms, () => { fn(); });
    globalThis.clearTimeout = (timer) => { timer.cancel(); };
    globalThis.setImmediate = globalThis.setTimeout;
    globalThis.queueMicrotask = (fn) => { Promise.resolve().then(fn); };

    try {
      await Effect.runPromise(Effect.sleep(Duration.millis(20)));
      note(out, "sleep", "ok");
    } catch (err) {
      note(out, "sleep-error", String(err));
    }

    try {
      const raced = await Effect.runPromise(
        Effect.race(
          Effect.sleep(Duration.millis(500)),
          Effect.succeed("fast"),
        ),
      );
      note(out, "race", raced);
    } catch (err) {
      note(out, "race-error", String(err));
    }

    await $.fs.write("probe-out/effect-after-shim.json", JSON.stringify({ out }));

    return next(e);
  });
};
