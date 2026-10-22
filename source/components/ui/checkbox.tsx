import { uiText } from "../../local-test/i18n";
"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-[#a9b3c2] bg-white shadow-[var(--sh-xs)] transition-[background-color,border-color,box-shadow] outline-none hover:border-[var(--c-accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--c-focus)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--c-danger)] data-[state=checked]:border-[var(--c-accent)] data-[state=checked]:bg-[var(--c-accent)] data-[state=checked]:text-white data-[state=indeterminate]:border-[var(--c-accent)] data-[state=indeterminate]:bg-[var(--c-accent)] data-[state=indeterminate]:text-white",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
