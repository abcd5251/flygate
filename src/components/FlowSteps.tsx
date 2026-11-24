import Link from "next/link";
import { Check } from "lucide-react";
import { cx } from "./ui";

const STEPS = [
  { href: "/", label: "Trip" },
  { href: "/mandate", label: "Sign" },
  { href: "/search", label: "Agent search" },
  { href: "/checkout", label: "Gate check" },
  { href: "/ticket", label: "Ticket" },
];

/** Checkout-style progress bar shown in the blue band of every flow page. */
export function FlowSteps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" aria-label="Booking steps">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.href} className="flex items-center gap-2">
            <Link
              href={s.href}
              aria-current={active ? "step" : undefined}
              className={cx(
                "inline-flex items-center gap-2 rounded-full px-3 py-1 transition",
                active && "bg-white font-bold text-brand",
                done && "text-white hover:bg-white/10",
                !active && !done && "text-white/60 hover:text-white",
              )}
            >
              <span
                className={cx(
                  "grid size-5 place-items-center rounded-full text-[11px] font-bold",
                  active && "bg-brand text-white",
                  done && "bg-white text-brand",
                  !active && !done && "border border-white/50",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              {s.label}
            </Link>
            {i < STEPS.length - 1 && <span className="h-px w-6 bg-white/40" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
