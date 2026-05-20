"use client";

import { useRef, useState } from "react";
import { useAccount } from "wagmi";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Download, Upload, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { exportStrategies, importStrategies } from "@/lib/backup";

export function BackupCard() {
  const { address, isConnected } = useAccount();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function flash(kind: "ok" | "err", msg: string) {
    setError(kind === "err" ? msg : null);
    setSuccess(kind === "ok" ? msg : null);
  }

  async function handleExport() {
    setError(null); setSuccess(null);
    if (!isConnected || !address) { setError("Connect your wallet first"); return; }
    const password = window.prompt("Password to encrypt your backup (min 8 chars):") ?? "";
    if (!password) return;
    const confirm = window.prompt("Confirm password:") ?? "";
    if (confirm !== password) { setError("Passwords do not match"); return; }

    setBusy("export");
    try {
      const { count, filename } = await exportStrategies(address.toLowerCase() as `0x${string}`, password);
      flash("ok", `Exported ${count} orders → ${filename}`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportClick() {
    setError(null); setSuccess(null);
    fileRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const password = window.prompt("Password to decrypt the backup:") ?? "";
    if (!password) return;

    setBusy("import");
    try {
      const text = await file.text();
      const { count, owner } = await importStrategies(text, password);
      const ownerWarning =
        address && owner.toLowerCase() !== address.toLowerCase()
          ? " (note: backup belongs to a different wallet)"
          : "";
      flash("ok", `Imported ${count} orders${ownerWarning}`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Order Backup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-on-surface-variant">
          Your order parameters are stored locally. Export an encrypted backup to restore
          on another device. The backup is AES-GCM encrypted with a password you choose
          (PBKDF2-SHA256, 250 000 iterations).
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            disabled={busy !== null || !isConnected}
            onClick={handleExport}
          >
            {busy === "export"
              ? <Loader2 size={14} className="animate-spin" />
              : <Download size={14} />}
            Export .zstrategy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            disabled={busy !== null}
            onClick={handleImportClick}
          >
            {busy === "import"
              ? <Loader2 size={14} className="animate-spin" />
              : <Upload size={14} />}
            Import Backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zstrategy,application/json"
            className="hidden"
            onChange={handleFile}
          />
        </div>
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-error">
            <AlertCircle size={12} /> {error}
          </div>
        )}
        {success && (
          <div className="flex items-center gap-1.5 text-xs text-primary-container">
            <CheckCircle2 size={12} /> {success}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
