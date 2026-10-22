import { uiText } from "../../local-test/i18n";
import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "control h-9 w-full min-w-0 rounded-md border border-input bg-white px-3 py-1 text-[16px] text-[var(--c-text)] shadow-[var(--sh-xs)] transition-[border-color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--c-text-4)] hover:border-[#b3bcc9] disabled:cursor-not-allowed disabled:bg-[var(--c-surface-2)] disabled:text-[var(--c-text-3)] sm:text-sm",
        "focus-visible:border-[var(--c-accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--c-focus)]",
        "aria-invalid:border-[var(--c-danger)] aria-invalid:ring-[3px] aria-invalid:ring-[rgb(180_35_54/0.15)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
