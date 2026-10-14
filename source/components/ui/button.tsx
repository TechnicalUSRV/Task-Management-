import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

// Button system: primary (one per area), secondary (soft accent), outline,
// ghost/text, destructive and link. Heights: xs 28 · sm 32 · default 36 · lg 40.
const buttonVariants = cva(
  "btn inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-[13.5px] leading-none font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--c-focus)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--c-accent)] text-white shadow-[var(--sh-xs)] hover:bg-[var(--c-accent-hover)] active:bg-[var(--c-accent-press)]",
        destructive:
          "bg-[var(--c-danger)] text-white shadow-[var(--sh-xs)] hover:bg-[#9c1d2e] focus-visible:ring-[rgb(180_35_54/0.3)]",
        outline:
          "border border-[var(--c-border-strong)] bg-white text-[var(--c-text-2)] shadow-[var(--sh-xs)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)] active:bg-[var(--c-surface-3)]",
        secondary:
          "bg-[var(--c-accent-soft)] text-[var(--c-accent-text)] hover:bg-[var(--c-accent-soft-2)]",
        ghost:
          "text-[var(--c-text-2)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)] active:bg-[var(--c-surface-3)]",
        link: "h-auto! px-0! text-[var(--c-accent-text)] underline-offset-4 hover:underline",
        "danger-outline":
          "border border-[var(--c-danger-border)] bg-white text-[var(--c-danger)] shadow-[var(--sh-xs)] hover:bg-[var(--c-danger-bg)]",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        xs: "h-7 gap-1.5 rounded-md px-2 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-md px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-4 text-sm has-[>svg]:px-3.5",
        icon: "size-9",
        "icon-xs": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Shows a spinner, keeps the label, and blocks repeat clicks. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? children : <>{loading && <Loader2 className="animate-spin" aria-hidden="true" />}{children}</>}
    </Comp>
  )
}

export { Button, buttonVariants }
