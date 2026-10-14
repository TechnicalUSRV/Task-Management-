import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "control flex field-sizing-content min-h-20 w-full rounded-md border border-input bg-white px-3 py-2 text-[16px] leading-relaxed text-[var(--c-text)] shadow-[var(--sh-xs)] transition-[border-color,box-shadow] outline-none placeholder:text-[var(--c-text-4)] hover:border-[#b3bcc9] focus-visible:border-[var(--c-accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--c-focus)] disabled:cursor-not-allowed disabled:bg-[var(--c-surface-2)] disabled:text-[var(--c-text-3)] aria-invalid:border-[var(--c-danger)] aria-invalid:ring-[3px] aria-invalid:ring-[rgb(180_35_54/0.15)] sm:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
