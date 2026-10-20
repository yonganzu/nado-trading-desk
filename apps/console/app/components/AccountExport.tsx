"use client";

import { useMemo, useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { CopyIcon, DownloadSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { exportEvmPrivateKeys, exportMnemonic } from "../lib/custody";

/** 触发一次本地文本下载（内容只在浏览器内生成，不经过服务端）。 */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 账户名 → 安全的下载文件名。 */
function safeName(name: string, slug: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-") || slug;
}

/** 「导出私钥 CSV」按钮：每行 index,address,private_key。
 *  私钥只在当前标签页内存中产生，直接写入本地下载文件。 */
export function ExportPrivateKeysButton({ slug, name, disabled }: {
  slug: string; name: string; disabled?: boolean;
}) {
  const [err, setErr] = useState<string | null>(null);

  const onClick = () => {
    try {
      const keys = exportEvmPrivateKeys(slug);
      if (keys.length === 0) throw new Error("该账户没有 EVM 钱包");
      const csv = [
        "index,address,private_key",
        ...keys.map((k) => `${k.index},${k.address},${k.privateKey}`),
      ].join("\n");
      // 带 BOM，Excel 直接打开不会乱码
      downloadText(`${safeName(name, slug)}-private-keys.csv`, `\uFEFF${csv}\n`, "text/csv;charset=utf-8");
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <Button size="sm" icon={DownloadSimpleIcon} disabled={disabled} onClick={onClick}>Export private keys</Button>
      {err && <Text variant="error" size="xs" as="span">{err}</Text>}
    </>
  );
}

/** HD 账户助记词面板：挂载时从保险库读出明文（只在内存中），卸载即丢弃。
 *  wative 的派生路径是标准 BIP44 m/44'/60'/0'/0/i，与 MetaMask / Rabby 默认一致。 */
export function MnemonicPanel({ slug, name, onClose }: {
  slug: string; name: string; onClose: () => void;
}) {
  const [mnemonic] = useState(() => exportMnemonic(slug));
  const [copied, setCopied] = useState(false);
  const words = useMemo(() => mnemonic.trim().split(/\s+/).filter(Boolean), [mnemonic]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-kumo-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text bold as="span">Mnemonic · {name}</Text>
        <span className="flex items-center gap-2">
          <Button size="sm" icon={CopyIcon} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Hide</Button>
        </span>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {words.map((w, i) => (
          <li key={`${i}-${w}`} className="flex items-center gap-2 rounded-sm bg-kumo-base px-2 py-1">
            <Text variant="secondary" size="xs" as="span">{i + 1}</Text>
            <Text variant="mono" as="span">{w}</Text>
          </li>
        ))}
      </ol>
      <Banner
        variant="error"
        size="sm"
        icon={<WarningCircleIcon weight="fill" />}
        description="助记词等于这整批钱包的控制权：不要截图、不要上传网盘，导出后请离线保存。"
      />
    </div>
  );
}
