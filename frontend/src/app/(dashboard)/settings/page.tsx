import { Topbar } from "@/components/layout/Topbar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Shield } from "lucide-react";
import { BackupCard } from "@/components/BackupCard";

export default function SettingsPage() {
  return (
    <>
      <Topbar title="Settings" />
      <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-3xl">
        {/* Privacy */}
        <Card variant="trust-violet">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield size={15} className="text-secondary" />
              Privacy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                title: "Flashbots Protect",
                desc: "Route transactions via private mempool",
              },
              {
                title: "Per-Order Secrets",
                desc: "Derive a unique user_secret per order to prevent cross-order linking",
              },
            ].map((item, i) => (
              <div key={item.title}>
                {i > 0 && <div className="h-px bg-outline-variant/10 mb-3" />}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <p className="text-sm text-on-surface font-medium">{item.title}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{item.desc}</p>
                  </div>
                  <Badge variant="sovereign" dot className="shrink-0">Active</Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <BackupCard />
      </div>
    </>
  );
}
