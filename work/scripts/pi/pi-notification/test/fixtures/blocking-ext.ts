/**
 * 阻塞对照组（**测试夹具**）。
 *
 * 与通知插件一起加载后，`agent_settled` 内故意 `await` 一段时间。
 * 如果被测的「settled 内不阻塞」断言真的有效，那么装上它之后
 * `settled_enter → 下一次 agent_start` 的间隔必须显著变大。
 *
 * 没有这个对照组，那条断言只是"看起来过了"，无法证明测量本身能识别阻塞。
 */

const BLOCK_MS = Number(process.env.PROBE_BLOCK_MS ?? 2000);

export default function blockingExtension(pi) {
  pi.on("agent_settled", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, Number.isFinite(BLOCK_MS) && BLOCK_MS > 0 ? BLOCK_MS : 2000);
    });
  });
}
