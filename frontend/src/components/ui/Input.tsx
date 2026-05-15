import { cn } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  suffix?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, error, suffix, id, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={id}
            className="text-xs font-medium text-on-surface-variant uppercase tracking-widest"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={id}
            className={cn(
              "w-full bg-surface-container-lowest text-on-surface text-sm",
              "px-3 py-2.5 rounded-sm",
              "border-b border-outline-variant/30",
              "placeholder:text-on-surface-variant/40",
              "outline-none transition-all duration-150",
              "focus:border-primary-container focus:glow-primary",
              error && "border-error focus:border-error",
              suffix && "pr-12",
              className,
            )}
            {...props}
          />
          {suffix && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant font-medium">
              {suffix}
            </span>
          )}
        </div>
        {hint && !error && (
          <p className="text-xs text-on-surface-variant">{hint}</p>
        )}
        {error && (
          <p className="text-xs text-error">{error}</p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";

export { Input };
