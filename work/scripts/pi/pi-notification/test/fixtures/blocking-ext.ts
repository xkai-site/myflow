/**
 * Blocking control fixture.
 *
 * Loaded next to the notification plugin, it deliberately awaits inside `agent_settled`. If the
 * "settle does not block" assertion is really effective, installing this must widen the interval
 * between `settled_enter` and the next `agent_start` significantly.
 *
 * Without this control group that assertion would only look like it passed; it would not show that
 * the measurement can detect blocking at all.
 */

const BLOCK_MS = Number(process.env.PROBE_BLOCK_MS ?? 2000);

export default function blockingExtension(pi) {
  pi.on("agent_settled", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, Number.isFinite(BLOCK_MS) && BLOCK_MS > 0 ? BLOCK_MS : 2000);
    });
  });
}
