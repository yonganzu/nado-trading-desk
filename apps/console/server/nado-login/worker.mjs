// =============================================================================
// app.nado.xyz 「钱包登录 / 注册」自动化 worker（本地 Node 进程，由 console 的
// /api/nado/login 路由启动）。
//
// 工作方式：
//   1. 从 stdin 读取待登录钱包（{index,address,privateKey} 数组）——只存在于内存；
//   2. 用 Playwright 打开真实 Chrome（channel=chrome），每个钱包一个独立 browser context
//      （隔离 Privy 的 localStorage，避免串号）；
//   3. 向页面注入一个兼容 MetaMask 的 EIP-1193 provider，私钥留在 Node 端，
//      页面只能通过 exposeFunction 请求签名；
//   4. 点击官网的 Sign In -> MetaMask，等待隐私登录完成（Sign In 消失且显示钱包地址）；
//   5. 以 NDJSON 形式向 stdout 输出进度，供 API 轮询。
//
// 安全约定：私钥不写日志、不写文件、不放进命令行参数。
// =============================================================================
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const APP_URL = process.env.NADO_ONBOARD_URL || "https://app.nado.xyz/perpetuals?market=BTC";
const CHAIN_ID_HEX = "0xdef1"; // Ink 57073
const CHAIN_ID_DEC = String(parseInt(CHAIN_ID_HEX, 16));
const SHOT_DIR = join(process.cwd(), ".nado-login-shots");
const WALLET_TIMEOUT_MS = Number(process.env.NADO_ONBOARD_WALLET_TIMEOUT_MS || 90_000);
// 单个浏览器内允许的最大并发数（每个并发 = 一个独立 context + 一个官网标签页）
const MAX_CONCURRENCY = Number(process.env.NADO_ONBOARD_MAX_CONCURRENCY || 8);

/** 向页面注入的 EIP-1193 provider（声明为 MetaMask，签名回调到 Node 端）。 */
function injectWallet(config) {
  const { address, chainId, chainIdDec } = config;
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) {
      try { cb(payload); } catch { /* 忽略第三方监听器异常 */ }
    }
  };

  const provider = {
    isMetaMask: true,
    isConnected: () => true,
    chainId,
    networkVersion: chainIdDec,
    selectedAddress: null,
    async request({ method, params }) {
      window.__nadoWalletLog?.(`request ${method}`);
      switch (method) {
        case "eth_chainId": return chainId;
        case "net_version": return chainIdDec;
        case "eth_accounts": return provider.selectedAddress ? [provider.selectedAddress] : [];
        case "eth_requestAccounts": {
          provider.selectedAddress = address;
          emit("connect", { chainId });
          emit("accountsChanged", [address]);
          return [address];
        }
        case "wallet_requestPermissions": {
          provider.selectedAddress = address;
          return [{ parentCapability: "eth_accounts" }];
        }
        case "wallet_getPermissions": return [];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "eth_signTypedData_v4": {
          const raw = typeof params?.[1] === "string" ? params[1] : JSON.stringify(params?.[1]);
          return window.__nadoSignTypedData(raw);
        }
        case "personal_sign":
        case "eth_sign": {
          const raw = params?.[0];
          return window.__nadoSignMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
        }
        case "eth_sendTransaction":
        case "eth_signTransaction":
          throw Object.assign(new Error("登录流程不允许发送交易"), { code: 4001 });
        default: {
          const err = new Error(`注入钱包不支持方法 ${method}`);
          err.code = 4200;
          throw err;
        }
      }
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return provider;
    },
    removeListener(event, cb) {
      const arr = listeners.get(event) ?? [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
      return provider;
    },
    enable: async () => provider.request({ method: "eth_requestAccounts" }),
    send: (methodOrPayload, paramsOrCb) => (typeof methodOrPayload === "string"
      ? provider.request({ method: methodOrPayload, params: paramsOrCb })
      : provider.request({ method: methodOrPayload.method, params: methodOrPayload.params })),
    sendAsync: (payload, cb) => {
      provider.request({ method: payload.method, params: payload.params })
        .then((result) => cb(null, { id: payload.id, jsonrpc: "2.0", result }), (error) => cb(error));
    },
  };

  Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });
  window.ethereum.providers = [provider];

  // EIP-6963：Privy 等 DApp 用它发现浏览器里的钱包
  const info = Object.freeze({
    uuid: "8f3d1c2a-0000-4000-8000-000000000001",
    name: "MetaMask",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjZjY4NTFiIi8+PC9zdmc+",
    rdns: "io.metamask",
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

function emitLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 读取并解析 stdin 中的任务参数。 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("缺少任务参数（stdin 为空）");
  return JSON.parse(text);
}

/** 关闭 cookie 横幅（有就点，没有就跳过）。 */
async function dismissCookies(page) {
  for (const label of ["Reject All", "Accept All"]) {
    const btn = page.getByRole("button", { name: label });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click().catch(() => {});
      return;
    }
  }
}

/** 点击官网右上角的 Sign In。 */
async function clickSignIn(page) {
  const btn = page.getByRole("button", { name: /^sign in$/i });
  const count = await btn.count().catch(() => 0);
  if (!count) throw new Error("页面上找不到 Sign In 按钮");
  try {
    await btn.first().click({ timeout: 10_000 });
  } catch {
    // 可能被 cookie 横幅挡住：先关掉横幅再点一次
    await dismissCookies(page);
    await btn.first().click({ timeout: 10_000 });
  }
}

/** 在主页与各 iframe 中寻找并点击 MetaMask 登录入口。 */
async function clickMetaMask(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const btn = frame.getByRole("button", { name: /metamask/i });
      if (await btn.count().catch(() => 0)) {
        await btn.first().click().catch(() => {});
        return true;
      }
      const more = frame.getByText(/more options/i);
      if (await more.count().catch(() => 0)) await more.first().click().catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/** 等待 Privy 登录完成：Sign In 消失，且页面出现该钱包的地址（短地址形式）。 */
async function waitForSignedIn(page, address, timeoutMs = 45_000) {
  const short = address.slice(0, 6).toLowerCase();
  await page.waitForFunction((prefix) => {
    const text = document.body.innerText.toLowerCase();
    const stillSignedOut = [...document.querySelectorAll("button")]
      .some((b) => (b.textContent ?? "").trim().toLowerCase() === "sign in");
    return !stillSignedOut && text.includes(prefix);
  }, short, { timeout: timeoutMs, polling: 500 });
}

/** 关闭「We're Introducing Usernames」引导弹窗——它的全屏遮罩会挡住教程里的 Skip 按钮。 */
async function closeUsernameIntro(page) {
  const close = page.locator("[data-testid=base-dialog-container] [data-testid=close-dialog-button]").first();
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

/** 首次登录的条款弹窗：点击 Agree to Terms（未出现则视为已同意）。
 *  `timeoutMs` 控制等待弹窗出现的时长（检查模式下设短一些）。 */
async function acceptTerms(page, timeoutMs = 12_000) {
  const btn = page.locator("[data-testid=terms-of-use-dialog-agree-to-terms-button]").first();
  const intro = page.locator("[data-testid=username-intro-dialog-next-button]").first();
  // 轮询而不是死等：已注册的钱包不会弹条款（直接出现用户名引导，或什么都不弹），可以立刻返回
  const deadline = Date.now() + timeoutMs;
  let appeared = false;
  while (Date.now() < deadline) {
    if (await btn.isVisible().catch(() => false)) { appeared = true; break; }
    if (await intro.isVisible().catch(() => false)) return false;
    await page.waitForTimeout(200);
  }
  if (!appeared) return false;
  try {
    await btn.click({ timeout: 8_000 });
  } catch {
    // 被用户名弹窗遮罩挡住时，先关掉遮罩再点一次
    await closeUsernameIntro(page);
    await btn.click({ timeout: 8_000 }).catch(() => {});
  }
  // 只需等弹窗收起动画，后续引导弹窗由 setupUsername 自己等
  await page.waitForTimeout(600);
  return true;
}

/** 按钱包序号生成用户名（官网要求至少 6 个字符，这里补零成 nado001 形式）。 */
function usernameFor(index) {
  return `nado${String(Number(index) + 1).padStart(3, "0")}`;
}

/** 填入用户名并等待 Save 解禁（官网在后台校验重名，名字可用时按钮才会变亮）。 */
async function fillUsername(page, input, save, name) {
  await input.fill("");
  await input.fill(name);
  for (let i = 0; i < 20; i++) {
    if (!(await save.isDisabled().catch(() => true))) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** 首次登录的「设置用户名」弹窗：点 Next 进入表单，按钱包序号填名字并保存。
 *  弹窗没出现（该钱包已设置过用户名）时返回 null。 */
async function setupUsername(page, index, onNote) {
  const next = page.locator("[data-testid=username-intro-dialog-next-button]").first();
  // 引导弹窗是异步出现的：最多等 2.5 秒；已注册的钱包不会出现，直接返回 null
  const appeared = await next.waitFor({ state: "visible", timeout: 2_500 }).then(() => true).catch(() => false);
  if (!appeared) return null;
  await next.click({ timeout: 10_000 });

  const dialog = page.locator("[data-testid=base-dialog-container]").first();
  const input = dialog.getByPlaceholder(/enter name/i).first();
  await input.waitFor({ state: "visible", timeout: 15_000 });

  const save = dialog.getByRole("button", { name: /^save$/i }).first();
  let username = usernameFor(index);
  if (!(await fillUsername(page, input, save, username))) {
    // 序号名被占用或不合规时，追加随机后缀重试（仍保留序号前缀，便于对回钱包）
    const fallback = `${username}${Math.random().toString(36).slice(2, 6)}`;
    await onNote?.(`用户名「${username}」不可用，改用「${fallback}」`);
    username = fallback;
    if (!(await fillUsername(page, input, save, username))) throw new Error("用户名没有通过官网校验");
  }
  await save.click({ timeout: 10_000 });

  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return username;
}

/** 左下角新手教程（Get started on Ink / Deposit / Enable 1-Click Trading / Set trading preferences）：
 *  连续点击 Skip，最多 4 步。返回实际点击次数。 */
async function skipTutorial(page, maxSkips = 4) {
  let clicked = 0;
  let misses = 0;
  const deadline = Date.now() + 45_000;
  while (clicked < maxSkips && Date.now() < deadline) {
    await closeUsernameIntro(page);
    const skips = page.getByRole("button", { name: /^skip$/i });
    const count = await skips.count().catch(() => 0);
    let hit = false;
    for (let j = 0; j < count; j++) {
      const btn = skips.nth(j);
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ timeout: 8_000 }).catch(() => {});
      clicked++;
      hit = true;
      break;
    }
    if (!hit) {
      // 教程弹窗是异步出现的，短暂等待后再找；连续 2 次找不到就结束
      if (++misses >= 2) break;
      await page.waitForTimeout(800);
      continue;
    }
    misses = 0;
    await page.waitForTimeout(900);
  }
  return clicked;
}

/** 只读检查：条款弹窗是浏览器本地状态（新 context 必现），先同意它；
 *  之后若仍弹出「We're Introducing Usernames」引导，说明该钱包还没完成注册。 */
async function detectRegistration(page, onNote) {
  const agreed = await acceptTerms(page, 6_000);
  if (agreed) await onNote?.("检查时已接受条款弹窗（仅影响本次浏览器）");
  const intro = page.locator("[data-testid=username-intro-dialog-next-button]").first();
  const appeared = await intro.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
  return { registered: !appeared, reason: appeared ? "username-intro" : "no-onboarding-dialog" };
}

/** 单个钱包的完整登录流程。
 *  `mode = "check"` 时只登录并判断注册状态，不做任何引导操作。
 *  `onVerified` 在确认登录成功后立即回调（用于先向页面汇报结果）；
 *  `onNote` 用于上报引导流程的告警（不影响登录成功状态）；
 *  `keepOpenMs` > 0 时把浏览器窗口保留一段时间，方便人工查看登录状态。 */
async function loginWallet(browser, wallet, { keepOpenMs = 0, mode = "login", headless = false, onVerified, onNote } = {}) {
  const account = privateKeyToAccount(wallet.privateKey);
  if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`私钥与地址不匹配（期望 ${wallet.address}，实际 ${account.address}）`);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    // 关掉动画偏好，减少等过渡动画的时间
    reducedMotion: "reduce",
  });
  // 无窗口模式不需要图片 / 字体 / 视频：直接丢弃，页面更快、更省内存
  if (headless) {
    await ctx.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
  }
  const page = await ctx.newPage();
  try {
    // 签名能力只存在于 Node 端；页面拿不到私钥
    await page.exposeFunction("__nadoWalletLog", (msg) => {
      if (process.env.NADO_ONBOARD_DEBUG === "1") process.stderr.write(`[wallet ${wallet.index}] ${msg}\n`);
    });
    await page.exposeFunction("__nadoSignMessage", async (raw) => {
      const message = /^0x[0-9a-fA-F]*$/.test(raw) ? { raw } : raw;
      return account.signMessage({ message });
    });
    await page.exposeFunction("__nadoSignTypedData", async (raw) => account.signTypedData(JSON.parse(raw)));

    const script = `(${injectWallet.toString()})(${JSON.stringify({
      address: account.address, chainId: CHAIN_ID_HEX, chainIdDec: CHAIN_ID_DEC,
    })});`;
    await ctx.addInitScript(script);

    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    // 页面把 Sign In 渲染出来就可以继续（替代固定 4 秒等待）
    await page.getByRole("button", { name: /^sign in$/i }).first()
      .waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
    await dismissCookies(page);
    await clickSignIn(page);

    // Privy 弹窗由 clickMetaMask 自己轮询等待（替代固定 2.5 秒等待）
    const clicked = await clickMetaMask(page);
    if (!clicked) throw new Error("Privy 弹窗中找不到 MetaMask 选项");
    await waitForSignedIn(page, account.address);

    // 检查模式：只判断注册状态（是否还有用户名引导），不设置用户名
    if (mode === "check") {
      const reg = await detectRegistration(page, onNote);
      await onVerified?.({ registered: reg.registered });
      await page.waitForTimeout(500).catch(() => {});
      return;
    }

    // 首次登录的引导流程：同意条款 -> 设置用户名 -> 跳过新手教程。
    // 任何一步失败只记一条告警，不推翻已经成功的登录。
    let username = null;
    try {
      await acceptTerms(page);
      username = await setupUsername(page, wallet.index, onNote);
      if (username) await onNote?.(`已设置用户名 ${username}`);
      const skips = await skipTutorial(page, 4);
      if (skips < 4) await onNote?.(`新手教程只跳过 ${skips}/4 步`);
    } catch (e) {
      await onNote?.(`引导流程未全部完成：${e instanceof Error ? e.message : String(e)}`);
    }

    // 先汇报成功，再把窗口留给人工查看。
    // 窗口被提前关闭（人工关窗/浏览器退出）不算登录失败，等待异常直接忽略。
    await onVerified?.({ username });
    if (keepOpenMs > 0) await page.waitForTimeout(keepOpenMs).catch(() => {});
  } catch (e) {
    // 失败时留一张截图便于排查（文件名只含序号，不含私钥）
    try { await page.screenshot({ path: join(SHOT_DIR, `${wallet.index}-${Date.now()}.png`) }); } catch { /* 截图失败不影响主流程 */ }
    throw e;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const payload = await readStdin();
  const wallets = Array.isArray(payload?.wallets) ? payload.wallets : [];
  if (!wallets.length) throw new Error("wallets 为空");
  // 「登录并查看」模式：确认成功后让浏览器窗口停留（上限 10 分钟）
  const keepOpenMs = Math.max(0, Math.min(600_000, Number(payload?.keepOpenMs) || 0));
  // "check" = 只登录并判断注册状态（无头运行，不弹窗口）；默认 "login" = 完整注册流程
  const mode = payload?.mode === "check" ? "check" : "login";
  // 并发数：同一个浏览器里同时跑几个钱包（每个钱包一个独立 context），上限 8 避免把内存打满
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(Number(payload?.concurrency) || 1)));
  // 检查模式固定无头；批量登录默认无头（更快、更省内存）；
  // 「登录并查看」（keepOpenMs > 0）或显式要求时才打开窗口。
  const headless = mode === "check" ? true : keepOpenMs > 0 ? false : payload?.headless !== false;

  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  emitLine({ type: "start", total: wallets.length, concurrency });
  try {
    // 简单任务池：每个协程从队列里取下一个钱包，取完即退出
    let cursor = 0;
    const runner = async () => {
      while (cursor < wallets.length) {
        const wallet = wallets[cursor++];
        await runWallet(browser, wallet, { keepOpenMs, mode, headless });
      }
    };
    const lanes = Math.min(concurrency, wallets.length);
    await Promise.all(Array.from({ length: lanes }, runner));
    // 先汇报结束，浏览器关闭放到 finally 里慢慢收尾（Chrome 退出较慢，不该拖住页面轮询）
    emitLine({ type: "done" });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 登录（或检查）单个钱包，并把结果按钱包序号汇报给父进程。 */
async function runWallet(browser, wallet, { keepOpenMs, mode, headless }) {
  const startedAt = Date.now();
  let verified = false;
  emitLine({ type: "wallet", status: "running", index: wallet.index, address: wallet.address });
  try {
    // 成功的第一时间汇报，随后（查看模式）把窗口留在登录页
    await loginWallet(browser, wallet, {
      keepOpenMs,
      mode,
      headless,
      onVerified: (info) => {
        verified = true;
        emitLine({
          type: "wallet", status: "ok", index: wallet.index, address: wallet.address,
          ms: Date.now() - startedAt, username: info?.username ?? undefined,
          registered: typeof info?.registered === "boolean" ? info.registered : undefined,
        });
      },
      onNote: (note) => emitLine({ type: "log", index: wallet.index, note }),
    });
  } catch (e) {
    // 已经确认成功后的收尾异常（例如人工关窗）不再覆盖成功状态
    if (!verified) {
      const error = e instanceof Error ? e.message : String(e);
      emitLine({ type: "wallet", status: "failed", index: wallet.index, address: wallet.address, error, ms: Date.now() - startedAt });
    }
  }
}

main().catch((e) => {
  emitLine({ type: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
