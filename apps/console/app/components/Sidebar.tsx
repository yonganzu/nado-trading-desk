"use client";

import { Meter, Sidebar as KumoSidebar, Text } from "@cloudflare/kumo";
import type { AccountOption, WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { AccountFilter } from "./AccountFilter";
import { StrategyTabs } from "./StrategyTabs";
import { CustodyPanel } from "./CustodyPanel";
import { FundingPanel } from "./FundingPanel";
import type { InTabProduct } from "../lib/liveClient";
import { NetworkSwitch } from "./NetworkSwitch";
import { useNetwork } from "./NetworkProvider";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

interface Props {
  railOpen: boolean;                              // 左侧栏是否展开
  onToggleRail: () => void;                       // 折叠/展开左侧栏
  workspaceName: string;
  totalWallets: number;
  shownWallets: number;
  shown: WalletVM[];
  pickedWallets: WalletVM[];                      // 右侧钱包卡片上勾选的钱包（自成交配对的池子）
  accountOptions: AccountOption[];
  selectedAccounts: Set<string>;
  onAccountsChange: (next: Set<string>) => void;
  liveMarkets?: Market[];
  liveEnabled?: boolean;
  liveDefaultProduct?: InTabProduct;
  liveCohortSize?: number;
  onLiveCohortChange?: () => void;
  liveWallets?: WalletVM[];                       // live VMs (with readiness) for the Fund-cohort panel
  onFunded?: (walletIds: string[]) => void;       // repaint after a bulk fund
  onWalletChanged?: () => void;                   // 自成交分组写入 cohort 标签后刷新界面
  onRefreshBalances?: (walletIds: string[]) => Promise<void> | void; // 选中钱包组后按需读取组内钱包余额
}

/** Section label — Kumo's own sidebar group-label recipe (sentence case, never uppercased). */
const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm font-medium text-kumo-subtle">{children}</span>
);

/** Frozen left rail = Kumo's Sidebar (collapsible="none" on the Provider in page.tsx renders a fixed
 *  <aside> that never collapses or turns into a mobile sheet): Kumo Header for the brand, Kumo Content
 *  as the scroll area for the workspace summary, network, account filter and tool panels. */
export function Sidebar(props: Props) {
  const { net } = useNetwork();
  return (
    <KumoSidebar>
      <KumoSidebar.Header>
        {props.railOpen ? (
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              {/* 标题右侧放网络切换按钮（原来在下方内容区，挪上来更顺手、也不占纵向空间） */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Text variant="heading" as="span">Nado Trading Desk</Text>
                <NetworkSwitch inline />
              </div>
              <Text variant="secondary" size="xs" as="span">Fleet console · {props.workspaceName}</Text>
            </div>
            <button
              type="button"
              aria-label="收起左侧栏"
              title="收起左侧栏"
              onClick={props.onToggleRail}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-kumo-line text-kumo-subtle hover:text-kumo-default"
            >
              <CaretLeft size={14} weight="bold" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="展开左侧栏"
            title="展开左侧栏"
            onClick={props.onToggleRail}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-kumo-line text-kumo-subtle hover:text-kumo-default"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        )}
      </KumoSidebar.Header>

      {props.railOpen && (
      <KumoSidebar.Content>
        <div className="flex flex-col gap-5">
          <Meter
            label="Wallets shown"
            value={props.shownWallets}
            max={Math.max(props.totalWallets, 1)}
            customValue={`${props.shownWallets} / ${props.totalWallets}`}
            showValue
          />

          <div className="flex flex-col gap-2">
            <Label>Accounts</Label>
            <AccountFilter options={props.accountOptions} selected={props.selectedAccounts} onChange={props.onAccountsChange} />
          </div>

          <StrategyTabs
            wallets={props.pickedWallets}
            liveMarkets={props.liveMarkets}
            isLive={props.liveEnabled}
            onWalletChanged={props.onWalletChanged}
            onRefreshBalances={props.onRefreshBalances}
          />



          {props.liveEnabled && <CustodyPanel cohortSize={props.liveCohortSize} product={props.liveDefaultProduct} onCohortChange={props.onLiveCohortChange} isTestnet={net.isTestnet} />}

          {/* Fund cohort is a TESTNET-only bulk on-ramp (its mint step can't run on mainnet, where
              USDT0 is bridged) — hide it entirely on mainnet so it never burns real gas. */}
          {props.liveEnabled && net.isTestnet && props.liveWallets && props.liveWallets.length > 0 && <FundingPanel wallets={props.liveWallets} onFunded={props.onFunded} />}



          <Text variant="secondary" size="xs">
            {props.liveEnabled
              ? `Live ${net.networkName} enabled · live-cohort fires sign + submit to the real sequencer; mock wallets stay offline`
              : "Offline mock · no testnet · actions run the real adapter + plan runner"}
          </Text>
        </div>
      </KumoSidebar.Content>
      )}
    </KumoSidebar>
  );
}
