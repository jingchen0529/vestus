import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/15 text-primary border-primary/25",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive/15 text-destructive border-destructive/25",
        outline: "text-foreground border-border",
        success:
          "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
        warning:
          "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
        info: "border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
        purple:
          "border-transparent bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
  pulse?: boolean;
}

function Badge({ className, variant, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full mr-1.5",
            variant === "success" && "bg-emerald-500",
            variant === "destructive" && "bg-destructive",
            variant === "warning" && "bg-amber-500",
            variant === "info" && "bg-sky-500",
            variant === "purple" && "bg-purple-500",
            (!variant || variant === "default") && "bg-primary",
            pulse && "animate-pulse"
          )}
        />
      )}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
