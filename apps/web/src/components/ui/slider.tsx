import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    className={cn("relative flex w-full touch-none select-none items-center", className)}
    ref={ref}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-current opacity-20">
      <SliderPrimitive.Range className="absolute h-full bg-current opacity-100 motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-out" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-current bg-white shadow-sm outline-none ring-offset-2 motion-safe:transition-[left,transform,box-shadow] motion-safe:duration-150 motion-safe:ease-out hover:scale-110 focus-visible:ring-2 active:scale-95 disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
