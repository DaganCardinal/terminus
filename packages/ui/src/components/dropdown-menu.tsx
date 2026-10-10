import { Menu } from "@base-ui/react/menu"
import { cn } from "@terminus/ui/lib/utils"

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger

export function DropdownMenuContent({ className, ...props }: Menu.Popup.Props) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={8} align="end" className="z-50">
        <Menu.Popup
          className={cn(
            "min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

export function DropdownMenuItem({ className, ...props }: Menu.Item.Props) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}
