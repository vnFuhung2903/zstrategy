"use client";

import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "sovereign" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 font-sans font-medium transition-all duration-150",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container/50",
          // Variants
          variant === "primary" && [
            "bg-primary-container text-on-primary-container rounded-sm",
            "hover:brightness-110 hover:glow-primary active:scale-[0.98]",
          ],
          variant === "sovereign" && [
            "bg-secondary-container text-on-secondary-container rounded-sm",
            "hover:brightness-110 hover:glow-secondary active:scale-[0.98]",
          ],
          variant === "ghost" && [
            "bg-transparent border border-outline/20 text-on-surface rounded-sm",
            "hover:bg-surface-container-high active:scale-[0.98]",
          ],
          variant === "danger" && [
            "bg-error-container text-error rounded-sm",
            "hover:brightness-110 active:scale-[0.98]",
          ],
          // Sizes
          size === "sm" && "px-3 py-1.5 text-sm",
          size === "md" && "px-4 py-2 text-sm",
          size === "lg" && "px-6 py-3 text-base",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export { Button };
