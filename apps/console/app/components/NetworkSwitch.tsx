"use client";

import { useState } from "react";
import { Banner, Button, LayerDialog } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNetwork } from "./NetworkProvider";
import { NETWORKS } from "../lib/chainEnv";

const TESTNET = 763373;
const MAINNET = 57073;

/** 单按钮版网络切换：只显示「当前网络」，点一下就切到另一个网络（不再并排显示两网按钮）。
 *  切到 TESTNET 立即生效；切回 MAINNET 仍然先弹确认框（真实资金，且确认按钮带主网配色）。
 *  网络选择是客户端 + 服务端共读的 cookie，所以切换即时生效、不用重启。
 *  inline：紧凑形态（去掉 "Network" 标签、不占满宽度），用于塞进侧栏标题右边。 */
export function NetworkSwitch({ inline = false }: { inline?: boolean } = {}) {
  const { chainId, setChain } = useNetwork();
  const [confirm, setConfirm] = useState(false);

  const current = NETWORKS[chainId]?.networkName ?? "";
  const other = chainId === MAINNET ? TESTNET : MAINNET; // 点击后要切到的那一个

  const pick = (id: number) => {
    if (id === chainId) return;
    if (id === MAINNET) { setConfirm(true); return; } // guard before real funds
    setChain(id);                                     // testnet is instant
  };

  return (
    <div className={inline ? "shrink-0" : "flex flex-col gap-2"}>
      {!inline && <span className="text-sm font-medium text-kumo-subtle">Network</span>}
      {/* 只保留一个按钮：显示当前网络名，点击 = 切到另一个网络 */}
      <Button
        size={inline ? "xs" : "sm"}
        variant="primary"
        title={`当前 ${current}，点击切换到 ${NETWORKS[other]?.networkName ?? ""}`}
        aria-label={`网络：当前 ${current}，点击切换`}
        className={inline ? "shrink-0 capitalize" : "w-full capitalize"}
        onClick={() => pick(other)}
      >
        {current}
      </Button>

      <LayerDialog.Alert open={confirm} onOpenChange={setConfirm}>
        <LayerDialog.Content size="sm">
          <LayerDialog.Title>Switch to Mainnet?</LayerDialog.Title>
          <LayerDialog.Description>
            Mainnet moves <strong className="font-medium text-kumo-default">real funds</strong> — real USDT0 and ETH on Ink.
          </LayerDialog.Description>
          <LayerDialog.Body>
            <Banner
              variant="alert"
              size="sm"
              icon={<WarningIcon weight="fill" />}
              description="Orders, deposits and withdrawals will be real and irreversible."
            />
          </LayerDialog.Body>
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary
              variant="primary"
              data-net="mainnet"
              onClick={() => { setConfirm(false); setChain(MAINNET); }}
            >
              Switch to Mainnet
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}
