"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Breadcrumbs, Button, ButtonGroup, Empty, Input, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { LockIcon, SignInIcon, UsersThreeIcon, WalletIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { exportEvmPrivateKeys, listAccounts } from "../lib/custody";
import type { AccountVM } from "../lib/custody";
import type { NadoLoginJobView, WalletLoginResult } from "../lib/nadoLoginTypes";
import { NadoLoginResults } from "../components/NadoLoginResults";
import { useVault } from "../components/AppGate";

/** app.nado.xyz 的「钱包登录 / 注册」页：从已解锁保险库取钱包，经本机 Playwright 打开官网，
 *  点击 Sign In -> MetaMask 完成 Privy 登录。私钥只在内存中经 127.0.0.1 传给本地进程。 */
export default function NadoLoginPage() {
  const { relock } = useVault();
  const [accounts, setAccounts] = useState<AccountVM[]>([]);
  const [slug, setSlug] = useState("");
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<NadoLoginJobView | null>(null);
  // 产生当前结果表所用的账户（「登录并查看」要按同一账户取私钥）
  const [jobSlug, setJobSlug] = useState<string | null>(null);
  // 「登录并查看」的独立任务状态（与批量任务分开，避免覆盖结果表）
  const [inspect, setInspect] = useState<{ index: number; status: "starting" | "running" | "ok" | "failed"; error?: string } | null>(null);

  useEffect(() => {
    const list = listAccounts();
    setAccounts(list);
    setSlug(list[0]?.slug ?? "");
    setCount(Math.min(3, list[0]?.walletCount ?? 3));
  }, []);

  const account = useMemo(() => accounts.find((a) => a.slug === slug), [accounts, slug]);
  const maxCount = Math.max(1, account?.walletCount ?? 1);
  const effectiveCount = Math.min(Math.max(1, count), maxCount);

  // 轮询任务状态，直到任务结束
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/nado/login?jobId=${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as NadoLoginJobView;
          if (!stopped) {
            setJob(next);
            if (next.status === "running") timer = setTimeout(tick, 1500);
          }
          return;
        }
      } catch { /* 网络抖动时继续下一轮 */ }
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 800);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [jobId, jobStatus]);

  const start = async () => {
    if (!account) return;
    setBusy(true); setErr(null); setJob(null);
    try {
      // 私钥只在本标签页内存中产生，立即通过本地接口交给 worker，不落盘
      const keys = exportEvmPrivateKeys(account.slug, effectiveCount);
      if (keys.length === 0) throw new Error("该账户没有可登录的 EVM 钱包");
      const res = await fetch("/api/nado/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: keys, accountSlug: account.slug }),
      });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error ?? `启动失败 (${res.status})`);
      setJobSlug(account.slug);
      const first = await fetch(`/api/nado/login?jobId=${body.jobId}`, { cache: "no-store" });
      if (first.ok) setJob((await first.json()) as NadoLoginJobView);
      else setJob({ id: body.jobId, status: "running", total: keys.length, finished: 0, startedAt: Date.now(), results: [], log: [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 用单个钱包重新打开官网并保持登录态（窗口保留 2 分钟），方便人工确认登录状态。 */
  const inspectWallet = async (row: WalletLoginResult) => {
    if (!jobSlug) return;
    setInspect({ index: row.index, status: "starting" });
    try {
      const keys = exportEvmPrivateKeys(jobSlug, row.index + 1);
      const key = keys[row.index];
      if (!key) throw new Error("找不到该钱包的私钥，请重新解锁保险库后再试");
      if (key.address.toLowerCase() !== row.address.toLowerCase()) throw new Error("钱包序号与地址不匹配");
      const res = await fetch("/api/nado/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: [key], keepOpenMs: 120_000, accountSlug: jobSlug }),
      });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error ?? `启动失败 (${res.status})`);
      setInspect({ index: row.index, status: "running" });
      pollInspect(body.jobId, row.index);
    } catch (e) {
      setInspect({ index: row.index, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** 轮询「查看」任务，直到该钱包出现结果；窗口由 worker 继续保留。 */
  const pollInspect = (jobId: string, index: number) => {
    const tick = async () => {
      try {
        const res = await fetch(`/api/nado/login?jobId=${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const view = (await res.json()) as NadoLoginJobView;
          const row = view.results.find((r) => r.index === index);
          if (row?.status === "ok") { setInspect({ index, status: "ok" }); return; }
          if (row?.status === "failed") { setInspect({ index, status: "failed", error: row.error }); return; }
        }
      } catch { /* 网络抖动时继续重试 */ }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 800);
  };

  const inspectingIndex = inspect && (inspect.status === "starting" || inspect.status === "running") ? inspect.index : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <Breadcrumbs size="sm">
          <Breadcrumbs.Link href="/" icon={<WalletIcon size={16} />}>Wallets</Breadcrumbs.Link>
          <Breadcrumbs.Separator />
          <Breadcrumbs.Current>Nado login</Breadcrumbs.Current>
        </Breadcrumbs>
        <Button icon={LockIcon} onClick={relock}>Lock vault</Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">Nado 官网登录 / 注册</Text>
            <Text variant="secondary">
              用保险库里的钱包自动打开 app.nado.xyz，点击 Sign In → MetaMask 完成 Privy 登录（同一弹窗即注册）。
            </Text>
          </div>

          {accounts.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<UsersThreeIcon size={40} className="text-kumo-inactive" />}
                title="没有可用的账户"
                description="先到 Accounts 页面创建 HD / PK 账户并派生钱包。"
                contents={<LinkButton href="/accounts" variant="primary">去 Accounts</LinkButton>}
              />
            </LayerCard>
          ) : (
            <LayerCard>
              <LayerCard.Secondary>选择账户与数量</LayerCard.Secondary>
              <LayerCard.Primary className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Text variant="secondary" size="sm">账户</Text>
                  <ButtonGroup aria-label="Account">
                    {accounts.map((a) => (
                      <Button
                        key={a.slug}
                        size="sm"
                        variant={slug === a.slug ? "primary" : "secondary"}
                        aria-pressed={slug === a.slug}
                        onClick={() => { setSlug(a.slug); setCount(Math.min(3, Math.max(1, a.walletCount))); }}
                      >
                        {a.name} · {a.kind} · {a.walletCount}
                      </Button>
                    ))}
                  </ButtonGroup>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={maxCount}
                    label="登录钱包数量"
                    description={`该账户共 ${maxCount} 个 EVM 钱包`}
                    className="w-44"
                    value={effectiveCount}
                    onChange={(e) => setCount(Math.min(maxCount, Math.max(1, Number(e.target.value) || 1)))}
                  />
                  <Button
                    variant="primary"
                    icon={SignInIcon}
                    loading={busy || job?.status === "running"}
                    disabled={busy || job?.status === "running" || !account}
                    onClick={start}
                  >
                    {job?.status === "running" ? "登录中…" : "开始登录"}
                  </Button>
                  <Badge variant="secondary">{effectiveCount} / {maxCount}</Badge>
                </div>

                {err && (
                  <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={err} />
                )}

                <Text variant="secondary" size="xs">
                  私钥仅在当前标签页内存中导出，经 127.0.0.1 交给本机 Playwright 进程签名，不写数据库、不写日志。
                  自动化会打开一个真实 Chrome 窗口，逐个钱包点击官网 Sign In，并完成首次登录的引导：同意条款、
                  按序号设置用户名（nado001…）、跳过新手教程的 4 步 Skip。
                  注意：官网 ToU 禁止为奖励/空投刷量的行为，请自行评估合规风险。
                </Text>
              </LayerCard.Primary>
            </LayerCard>
          )}

          {job && (
            <LayerCard>
              <LayerCard.Secondary>登录结果</LayerCard.Secondary>
              <LayerCard.Primary className="flex flex-col gap-3">
                {job.results.length > 0
                  ? <>
                      <Text variant="secondary" size="xs">
                        点击任意一行的「登录并查看」，会用该钱包重新打开一个已登录的 Chrome 窗口（保留 2 分钟），
                        可直接在官网确认右上角地址、Deposit 等按钮是否正常显示。
                      </Text>
                      <NadoLoginResults
                        job={job}
                        onInspect={jobSlug ? inspectWallet : undefined}
                        inspectingIndex={inspectingIndex}
                      />
                    </>
                  : <Text variant="secondary">正在启动浏览器…</Text>}
                {inspect && (
                  <Banner
                    variant={inspect.status === "failed" ? "error" : "default"}
                    size="sm"
                    icon={inspect.status === "failed" ? <WarningCircleIcon weight="fill" /> : undefined}
                    description={
                      inspect.status === "starting"
                        ? `正在为 #${inspect.index} 打开浏览器…`
                        : inspect.status === "running"
                          ? `#${inspect.index} 正在登录，成功后 Chrome 窗口会保留 2 分钟供你查看`
                          : inspect.status === "ok"
                            ? `#${inspect.index} 登录成功，请在弹出的 Chrome 窗口中确认登录状态（约 2 分钟后自动关闭）`
                            : `#${inspect.index} 查看失败：${inspect.error ?? "未知错误"}`
                    }
                  />
                )}
              </LayerCard.Primary>
            </LayerCard>
          )}
        </div>
      </div>
    </div>
  );
}
