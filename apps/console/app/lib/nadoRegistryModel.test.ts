// 注册状态检查的单元测试：登记表合并规则、卡片状态映射、worker 结果归类。
import { describe, expect, it } from "vitest";
import {
  applyCheck,
  applyFailure,
  applyLogin,
  applyStoredStates,
  checkStateFromEntry,
  registryUpdateFor,
} from "./nadoRegistryModel";
import type { NadoRegistryEntry, WalletCheckState, WalletOutcome } from "./nadoRegistryModel";

const ADDR = "0xAbCd00000000000000000000000000000000Ef12";
const ADDR_LC = ADDR.toLowerCase();
const T0 = 1_700_000_000_000;

/** 构造一条已注册的历史记录。 */
function registeredEntry(extra: Partial<NadoRegistryEntry> = {}): NadoRegistryEntry {
  return {
    address: ADDR_LC,
    accountSlug: "fleet",
    walletIndex: 7,
    registered: true,
    username: "nado007",
    checkedAt: T0 - 1_000,
    lastAttemptAt: T0 - 1_000,
    source: "login",
    ...extra,
  };
}

describe("applyCheck", () => {
  it("首次检查为已注册：写入结论与时间，来源为 check", () => {
    const entry = applyCheck(undefined, { address: ADDR, walletIndex: 0, registered: true }, T0);
    expect(entry).toMatchObject({
      address: ADDR_LC, // 地址统一小写，保证一个钱包只有一条记录
      walletIndex: 0,
      registered: true,
      checkedAt: T0,
      lastAttemptAt: T0,
      source: "check",
    });
    expect(entry.lastError).toBeUndefined();
  });

  it("首次检查为未注册", () => {
    const entry = applyCheck(undefined, { address: ADDR, walletIndex: 3, registered: false }, T0);
    expect(entry.registered).toBe(false);
    expect(entry.username).toBeUndefined();
  });

  it("判定未注册时清掉旧用户名，但保留账户信息", () => {
    const prev = registeredEntry({ registered: false });
    const entry = applyCheck(prev, { address: ADDR, registered: false }, T0);
    expect(entry.username).toBeUndefined();
    expect(entry.accountSlug).toBe("fleet");
    expect(entry.walletIndex).toBe(7);
  });

  it("判定已注册时保留已知用户名", () => {
    const entry = applyCheck(registeredEntry(), { address: ADDR, registered: true }, T0);
    expect(entry.username).toBe("nado007");
    expect(entry.checkedAt).toBe(T0);
  });

  it("成功检查会清除上一次的错误", () => {
    const prev = registeredEntry({ lastError: "浏览器启动失败" });
    const entry = applyCheck(prev, { address: ADDR, registered: true }, T0);
    expect(entry.lastError).toBeUndefined();
  });
});

describe("applyLogin", () => {
  it("完整注册成功：已注册 + 用户名，来源为 login", () => {
    const entry = applyLogin(undefined, { address: ADDR, walletIndex: 2, username: "nado003" }, T0);
    expect(entry).toMatchObject({
      address: ADDR_LC,
      registered: true,
      username: "nado003",
      checkedAt: T0,
      lastAttemptAt: T0,
      source: "login",
    });
  });

  it("没拿到新用户名时保留旧用户名", () => {
    const entry = applyLogin(registeredEntry(), { address: ADDR }, T0);
    expect(entry.username).toBe("nado007");
    expect(entry.registered).toBe(true);
  });

  it("注册成功后清除历史错误", () => {
    const prev = registeredEntry({ lastError: "之前的失败" });
    expect(applyLogin(prev, { address: ADDR, username: "nado007" }, T0).lastError).toBeUndefined();
  });
});

describe("applyFailure", () => {
  it("失败不推翻已有结论，只记录错误与尝试时间", () => {
    const entry = applyFailure(registeredEntry(), { address: ADDR, error: "登录超时", mode: "check" }, T0);
    expect(entry.registered).toBe(true);
    expect(entry.username).toBe("nado007");
    expect(entry.checkedAt).toBe(T0 - 1_000); // 结论时间不动
    expect(entry.lastAttemptAt).toBe(T0);
    expect(entry.lastError).toBe("登录超时");
  });

  it("没有历史结论时只留错误，不凭空产生 registered", () => {
    const entry = applyFailure(undefined, { address: ADDR, error: "找不到 MetaMask", mode: "check" }, T0);
    expect(entry.registered).toBeUndefined();
    expect(entry.lastError).toBe("找不到 MetaMask");
    expect(entry.source).toBe("check");
  });

  it("登录模式的失败记录来源为 login", () => {
    expect(applyFailure(undefined, { address: ADDR, error: "x", mode: "login" }, T0).source).toBe("login");
  });
});

describe("checkStateFromEntry", () => {
  it("已注册 → registered 状态，带检查时间与用户名", () => {
    expect(checkStateFromEntry(registeredEntry())).toEqual({
      status: "registered",
      checkedAt: T0 - 1_000,
      username: "nado007",
    });
  });

  it("未注册 → unregistered 状态，不展示用户名", () => {
    expect(checkStateFromEntry(registeredEntry({ registered: false, username: undefined }))).toEqual({
      status: "unregistered",
      checkedAt: T0 - 1_000,
    });
  });

  it("没有结论但有错误 → failed 状态", () => {
    const entry: NadoRegistryEntry = { address: ADDR_LC, lastAttemptAt: T0, lastError: "worker 提前退出", source: "check" };
    expect(checkStateFromEntry(entry)).toEqual({ status: "failed", error: "worker 提前退出" });
  });

  it("没有记录或没有可用信息 → undefined（卡片不显示徽标）", () => {
    expect(checkStateFromEntry(null)).toBeUndefined();
    expect(checkStateFromEntry(undefined)).toBeUndefined();
    expect(checkStateFromEntry({ address: ADDR_LC, lastAttemptAt: T0, source: "check" })).toBeUndefined();
  });
});

describe("registryUpdateFor", () => {
  const base: Pick<WalletOutcome, "index" | "address" | "status"> = { index: 4, address: ADDR, status: "ok" };

  it("检查模式的成功结果 → 写注册结论，并带上账户信息", () => {
    expect(registryUpdateFor("check", { ...base, registered: false }, "fleet")).toEqual({
      kind: "check",
      address: ADDR,
      accountSlug: "fleet",
      walletIndex: 4,
      registered: false,
    });
  });

  it("检查模式成功但缺少 registered → 不写（避免把登录成功当成已注册）", () => {
    expect(registryUpdateFor("check", { ...base }, "fleet")).toBeNull();
  });

  it("登录模式的成功结果 → 写已注册与用户名", () => {
    expect(registryUpdateFor("login", { ...base, username: "nado005" }, "fleet")).toEqual({
      kind: "login",
      address: ADDR,
      accountSlug: "fleet",
      walletIndex: 4,
      username: "nado005",
    });
  });

  it("失败结果 → 写错误，并保留模式", () => {
    expect(registryUpdateFor("check", { ...base, status: "failed", error: "登录超时" }, "fleet")).toEqual({
      kind: "failure",
      address: ADDR,
      accountSlug: "fleet",
      walletIndex: 4,
      error: "登录超时",
      mode: "check",
    });
  });

  it("失败但没带原因 → 使用兜底文案", () => {
    const update = registryUpdateFor("login", { ...base, status: "failed" });
    expect(update).toMatchObject({ kind: "failure", error: "自动化执行失败", mode: "login" });
  });

  it("pending / running 不写登记表", () => {
    expect(registryUpdateFor("login", { ...base, status: "pending" })).toBeNull();
    expect(registryUpdateFor("check", { ...base, status: "running" })).toBeNull();
  });
});

describe("applyStoredStates（首页回填）", () => {
  const wallets = [
    { id: "w-0", address: ADDR },
    { id: "w-1", address: "0x0000000000000000000000000000000000000002" },
  ];
  const another = "0x0000000000000000000000000000000000000002";

  it("按地址把后端结果一一对应到钱包 id", () => {
    const stored: Record<string, WalletCheckState> = {
      [ADDR_LC]: { status: "registered", checkedAt: T0, username: "nado040" },
    };
    const next = applyStoredStates({}, stored, wallets);
    expect(next["w-0"]).toEqual({ status: "registered", checkedAt: T0, username: "nado040" });
    expect(next["w-1"]).toBeUndefined(); // 没有记录的钱包保持不显示徽标
  });

  it("地址大小写不同也能匹配（登记表统一小写）", () => {
    const next = applyStoredStates({}, { [ADDR_LC]: { status: "unregistered", checkedAt: T0 } }, wallets);
    expect(next["w-0"]?.status).toBe("unregistered");
  });

  it("正在检查中的钱包不被旧结果覆盖", () => {
    const cur: Record<string, WalletCheckState> = { "w-0": { status: "running" } };
    const next = applyStoredStates(cur, { [ADDR_LC]: { status: "unregistered", checkedAt: T0 } }, wallets);
    expect(next).toBe(cur); // 无变化时返回原对象，避免多余渲染
  });

  it("已注册优先于未注册，且更新的结论覆盖旧结论", () => {
    const cur: Record<string, WalletCheckState> = {
      "w-0": { status: "unregistered", checkedAt: T0 - 1_000 },
      "w-1": { status: "registered", checkedAt: T0 - 1_000 },
    };
    const stored: Record<string, WalletCheckState> = {
      [ADDR_LC]: { status: "registered", checkedAt: T0 },
      [another]: { status: "unregistered", checkedAt: T0 }, // 不能把已注册降级
    };
    const next = applyStoredStates(cur, stored, wallets);
    expect(next["w-0"]).toEqual({ status: "registered", checkedAt: T0 });
    expect(next["w-1"]).toEqual({ status: "registered", checkedAt: T0 - 1_000 });
  });

  it("后端的失败记录不抹掉本地已有结论", () => {
    const cur: Record<string, WalletCheckState> = {
      "w-0": { status: "registered", checkedAt: T0, username: "nado040" },
    };
    const stored: Record<string, WalletCheckState> = { [ADDR_LC]: { status: "failed", error: "登录超时" } };
    expect(applyStoredStates(cur, stored, wallets)).toBe(cur);
  });
});

describe("批量结果一一对应", () => {
  it("每个地址只更新自己的记录，互不覆盖", () => {
    const wallets = [
      { index: 0, address: "0x0000000000000000000000000000000000000001", registered: true },
      { index: 1, address: "0x0000000000000000000000000000000000000002", registered: false },
      { index: 2, address: "0x0000000000000000000000000000000000000003", registered: true },
    ];
    // 模拟任务管理器的处理过程：worker 结果 -> 登记表更新
    const table: Record<string, NadoRegistryEntry> = {};
    for (const w of wallets) {
      const update = registryUpdateFor(
        "check",
        { index: w.index, address: w.address, status: "ok", registered: w.registered },
        "fleet",
      );
      if (update?.kind !== "check") throw new Error("应当写入检查结果");
      table[update.address] = applyCheck(table[update.address], update, T0 + w.index);
    }

    const [w0, w1, w2] = wallets;
    if (!w0 || !w1 || !w2) throw new Error("测试数据缺失");
    expect(Object.keys(table)).toHaveLength(3);
    expect(table[w0.address]).toMatchObject({ walletIndex: 0, registered: true, checkedAt: T0 });
    expect(table[w1.address]).toMatchObject({ walletIndex: 1, registered: false, checkedAt: T0 + 1 });
    expect(table[w2.address]).toMatchObject({ walletIndex: 2, registered: true, checkedAt: T0 + 2 });
    // 卡片状态也各取各的
    expect(checkStateFromEntry(table[w1.address])?.status).toBe("unregistered");
    expect(checkStateFromEntry(table[w2.address])?.status).toBe("registered");
  });
});
