"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  TrendingUp,
  Shield,
  Terminal,
  Repeat2,
  Activity,
  Settings,
  Zap,
  X,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useKeeperHealth } from "@/hooks/useBackendApi";

const nav = [
  { href: "/dashboard", label: "Command Center", icon: LayoutDashboard },
  { href: "/strategy",  label: "Strategy Builder", icon: TrendingUp },
  { href: "/vault",     label: "Vault",            icon: Shield },
  { href: "/zk",        label: "ZK Terminal",      icon: Terminal },
  { href: "/dca",       label: "DCA Pulse",        icon: Repeat2 },
  { href: "/activity",  label: "Activity",         icon: Activity },
  { href: "/settings",  label: "Settings",         icon: Settings },
];

function KeeperStatus() {
  const { data, isLoading, isError } = useKeeperHealth();
  const online = !!data?.online && !isError;
  const label = isLoading ? "Keeper…" : online ? "Keeper online" : "Keeper offline";
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-sm bg-surface-container">
      <span className={cn(
        "w-1.5 h-1.5 rounded-full",
        online ? "bg-primary-container animate-pulse" : "bg-error",
      )} />
      <span className="text-xs text-on-surface-variant">{label}</span>
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      <nav className="flex flex-col gap-0.5 p-2 flex-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-sm text-sm transition-all duration-150",
                active
                  ? "bg-surface-container text-on-surface font-medium glow-primary"
                  : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
              )}
            >
              <Icon
                size={16}
                className={active ? "text-primary-container" : "text-on-surface-variant"}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-outline-variant/10">
        <KeeperStatus />
      </div>
    </>
  );
}

const Logo = () => (
  <div className="flex items-center gap-2">
    <div className="w-7 h-7 rounded-sm bg-primary-container flex items-center justify-center shrink-0">
      <Zap size={14} className="text-on-primary-container" />
    </div>
    <span className="font-display font-semibold text-on-surface tracking-tight">zstrategy</span>
  </div>
);

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="md:hidden p-2 rounded-sm text-on-surface-variant hover:bg-surface-container transition-colors"
      aria-label="Open menu"
    >
      <Menu size={20} />
    </button>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-surface-container-low h-screen sticky top-0">
        <div className="flex items-center gap-2 px-4 py-5 border-b border-outline-variant/10">
          <Logo />
        </div>
        <NavItems />
      </aside>

      {/* Mobile hamburger button — rendered inside Topbar via prop, but also here as fallback */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-40 p-2 rounded-sm bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-outline-variant/10 transition-colors"
        aria-label="Open menu"
      >
        <Menu size={18} />
      </button>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "md:hidden fixed top-0 left-0 z-50 flex flex-col w-64 h-full bg-surface-container-low transition-transform duration-200",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-5 border-b border-outline-variant/10">
          <Logo />
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-sm text-on-surface-variant hover:bg-surface-container transition-colors"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>
        <NavItems onNavigate={() => setMobileOpen(false)} />
      </aside>
    </>
  );
}
