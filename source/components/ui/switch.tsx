"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-[#c2cad6] shadow-[inset_0_1px_2px_rgb(16_24_40/0.12)] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--c-focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--c-accent)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(16_24_40/0.25)] ring-0 transition-transform data-[state=checked]:translate-x-[17px] data-[state=unchecked]:translate-x-[1px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
