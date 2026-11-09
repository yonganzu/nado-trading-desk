import { beforeEach, describe, expect, it } from "vitest";
import { parseSignal } from "./strategySignalModel";
import {
  claimSignal, createSignal, finishSignal, getSignal, listSignals, publicSignal, resetSignalsForTest,
} from "./strategySignals";

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function make(over: Record<string, unknown> = {}) {
  const parsed = parseSignal({ wallet: WALLET, market: "BTC-USD", side: "buy", kind: "limit", size: "0.01", price: "60000", ...over });
  if (!parsed.ok) throw new Error(parsed.error);
  return createSignal(parsed.value);
}

describe("策略信号队列", () => {
  beforeEach(() => resetSignalsForTest());

  it("新信号处于 pending，可按状态查询", () => {
    const { signal, created } = make();
    expect(created).toBe(true);
    expect(signal.status).toBe("pending");
    expect(listSignals("pending")).toHaveLength(1);
    expect(listSignals("done")).toHaveLength(0);
  });

  it("相同 clientId 重复提交只产生一条信号", () => {
    const a = make({ clientId: "strat-1" });
    const b = make({ clientId: "strat-1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.signal.id).toBe(a.signal.id);
    expect(listSignals()).toHaveLength(1);
  });

  it("同一信号只能被领取一次", () => {
    const { signal } = make();
    const first = claimSignal(signal.id);
    expect(first.ok).toBe(true);
    const second = claimSignal(signal.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe(409);
  });

  it("回写结果必须带正确的领取凭证", () => {
    const { signal } = make();
    const claimed = claimSignal(signal.id);
    if (!claimed.ok) throw new Error(claimed.error);

    const wrong = finishSignal(signal.id, "not-the-token", { status: "done" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe(409);

    const ok = finishSignal(signal.id, claimed.token, { status: "done", order: { status: "open" } });
    expect(ok.ok).toBe(true);
    expect(getSignal(signal.id)?.status).toBe("done");
    expect(getSignal(signal.id)?.order?.status).toBe("open");
  });

  it("失败结果会记录原因", () => {
    const { signal } = make();
    const claimed = claimSignal(signal.id);
    if (!claimed.ok) throw new Error(claimed.error);
    finishSignal(signal.id, claimed.token, { status: "error", error: "余额不足" });
    const stored = getSignal(signal.id);
    expect(stored?.status).toBe("error");
    expect(stored?.error).toBe("余额不足");
  });

  it("对外展示不暴露领取凭证", () => {
    const { signal } = make();
    claimSignal(signal.id);
    const view = publicSignal(getSignal(signal.id)!);
    expect("claimToken" in view).toBe(false);
  });

  it("执行快照会随结果一起保存", () => {
    const { signal } = make();
    const claimed = claimSignal(signal.id);
    if (!claimed.ok) throw new Error(claimed.error);
    finishSignal(signal.id, claimed.token, {
      status: "done",
      execution: { position: { side: "long", size: "0.01", entryPrice: "60000" }, openOrders: 1 },
    });
    const stored = getSignal(signal.id);
    expect(stored?.execution?.position?.side).toBe("long");
    expect(stored?.execution?.openOrders).toBe(1);
  });

  it("已结束的信号不能被再次领取", () => {
    const { signal } = make();
    const claimed = claimSignal(signal.id);
    if (!claimed.ok) throw new Error(claimed.error);
    finishSignal(signal.id, claimed.token, { status: "done" });
    const again = claimSignal(signal.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe(409);
  });
});
