import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

type BadgeVariant = "default" | "primary" | "sovereign" | "tertiary" | "error" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

function Badge({ className, variant = "default", dot, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-sans font-medium rounded-sm uppercase tracking-widest",
        variant === "default" && "bg-surface-container-highest text-on-surface-variant",
        variant === "primary" && "bg-primary-container/10 text-primary-container",
        variant === "sovereign" && "bg-secondary-container/10 text-secondary",
        variant === "tertiary" && "bg-tertiary-container/10 text-tertiary-container",
        variant === "error" && "bg-error-container/20 text-error",
        variant === "outline" && "border border-outline/30 text-on-surface-variant",
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            variant === "primary" && "bg-primary-container",
            variant === "sovereign" && "bg-secondary",
            variant === "tertiary" && "bg-tertiary-container",
            variant === "error" && "bg-error",
            (variant === "default" || variant === "outline") && "bg-on-surface-variant",
          )}
        />
      )}
      {children}
    </span>
  );
}

export { Badge };
